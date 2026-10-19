import type { ServerMessage, SessionSummary } from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { type Logger, silentLogger } from '../config/logger.ts';
import type { DriverFactory } from './driver-factory.ts';
import { forEachLimit, Limiter, settleWithin } from './limiter.ts';
import type { RemoteSweeper } from './remote-sessions.ts';
import {
  SessionRuntime,
  type SessionRuntimeOptions,
  type UserNotifier,
} from './session-runtime.ts';
import type { TransportFactory } from './transport-factory.ts';
import type { FileHost, HostKeyStore, SessionHost, SessionRecord, SessionStore } from './types.ts';

/** Boot restore (plan §5.8): at most 4 connects at once, spaced per host. */
export const RESTORE_CONCURRENCY = 4;
export const RESTORE_HOST_SPACING_MS = 500;
/** Daemon shutdown budget for the runtimes (inside compose's 30 s grace period). */
export const SHUTDOWN_BUDGET_MS = 20_000;
/**
 * A runtime that is idle (session not meant to run, nobody attached) this long is disposed: an
 * attach to an ended session loads a runtime with its own emulator, and nothing else would ever
 * free it. A later attach simply loads the session again.
 */
export const RUNTIME_IDLE_TTL_MS = 60_000;
/**
 * Idle runtimes one user may have loaded at once (each holds an emulator of about 0.5 MiB at the
 * default scrollback). Attaching to many ended sessions, or retrying them, within the idle TTL
 * would otherwise load one per session: beyond the cap, the user's least recently idle runtimes
 * are evicted at once.
 */
export const MAX_IDLE_RUNTIMES_PER_USER = 16;
/**
 * A terminate answers within this long (web's internal API calls time out after 5 s): a remote
 * cleanup still running then (plan D-30) ends the session later, through `session.status`.
 */
export const TERMINATE_ANSWER_MS = 3_000;
/** One-shot remote cleanups (plan D-30) running at once in the process: no SSH storms. */
export const REMOTE_CLEANUP_CONCURRENCY = 4;
/** Terminations "End all sessions" and the admin's terminate-sessions start at once. */
export const TERMINATE_ALL_CONCURRENCY = 4;

/** What boot restore did (plan §5.8). */
export interface RestoreSummary {
  /** Sessions it started (reattached, for tmux-protected ones). */
  restored: number;
  /** Sessions left `terminating` by the previous daemon, ended instead. */
  endedInterrupted: number;
}

export interface SessionRegistryOptions {
  store: SessionStore;
  hostKeys: HostKeyStore;
  transports: TransportFactory;
  drivers: DriverFactory;
  notifier: UserNotifier;
  installationId: string;
  logger?: Logger;
  restoreConcurrency?: number;
  restoreHostSpacingMs?: number;
  /** Default RUNTIME_IDLE_TTL_MS. */
  idleTtlMs?: number;
  /** Default MAX_IDLE_RUNTIMES_PER_USER. */
  maxIdleRuntimesPerUser?: number;
  /** Default TERMINATE_ANSWER_MS. */
  terminateAnswerMs?: number;
  /** Background leftover sweep (plan D-30) handed to every runtime; absent: none. */
  sweeper?: RemoteSweeper;
  /** Extra runtime options (timings in tests). */
  runtime?: Partial<
    Pick<
      SessionRuntimeOptions,
      | 'promptTimeoutMs'
      | 'resizeDebounceMs'
      | 'lagPollMs'
      | 'ingestPollMs'
      | 'random'
      | 'now'
      | 'cleanupConnectTimeoutMs'
    >
  >;
}

/**
 * A session whose server was deleted (`server_id` NULL) never connects again (plan D-29): Retry
 * and Reopen answer NOT_FOUND "server was deleted" before anything changes, and the runtime parks
 * any other connect attempt (boot restore included) as `failed` with NOT_FOUND.
 */
function requireServer(record: SessionRecord | null): void {
  if (record?.serverId === null) {
    throw new TermdockError(ErrorCode.NotFound, 'server was deleted');
  }
}

/**
 * Owns every session runtime of the process. The internal API (create/terminate/retry/reopen)
 * and the WebSocket server reach sessions only through here.
 *
 * Eviction: a runtime that reports itself idle gets a timer; when it fires and the runtime is
 * still idle, still the session's runtime and not in use by a registry operation (pinned), it
 * leaves the map first and is disposed after. The map entry is the only way to reach a runtime,
 * so a later attach loads a fresh one, never the disposed one, and never a second one while the
 * first is live. Timers stop at shutdown. A user with more than `maxIdleRuntimesPerUser` idle
 * runtimes loses the least recently idle ones at once, through the same path (never a pinned one,
 * nor the one that just became idle).
 */
export class SessionRegistry {
  readonly #options: SessionRegistryOptions;
  readonly #runtimes = new Map<string, SessionRuntime>();
  readonly #loading = new Map<string, Promise<SessionRuntime | null>>();
  /** Sessions queued for boot restore and not started yet. */
  readonly #pendingRestore = new Set<string>();
  readonly #evictions = new Map<string, ReturnType<typeof setTimeout>>();
  /** Registry operations in progress per session: their runtime is never evicted meanwhile. */
  readonly #pins = new Map<string, number>();
  /**
   * When each idle runtime last became idle (or was used by an operation), as an increasing
   * sequence number: the cap evicts the lowest first, the order the idle TTL would take.
   */
  readonly #idleSince = new Map<string, number>();
  #idleSeq = 0;
  readonly #idleTtlMs: number;
  readonly #maxIdlePerUser: number;
  readonly #terminateAnswerMs: number;
  /** Shared by every runtime's one-shot remote cleanup (plan D-30). */
  readonly #cleanups = new Limiter(REMOTE_CLEANUP_CONCURRENCY);
  readonly #log: Logger;
  #closed = false;

  constructor(options: SessionRegistryOptions) {
    this.#options = options;
    this.#idleTtlMs = options.idleTtlMs ?? RUNTIME_IDLE_TTL_MS;
    this.#maxIdlePerUser = options.maxIdleRuntimesPerUser ?? MAX_IDLE_RUNTIMES_PER_USER;
    this.#terminateAnswerMs = options.terminateAnswerMs ?? TERMINATE_ANSWER_MS;
    this.#log = options.logger ?? silentLogger();
  }

  /** A loaded runtime, or undefined. */
  host(sessionId: string): SessionRuntime | undefined {
    return this.#runtimes.get(sessionId);
  }

  /**
   * The file panel's view of a loaded runtime (plan §5.12). Not loaded, or loaded and not `ready`,
   * the file service answers SESSION_NOT_CONNECTED.
   */
  fileHost(sessionId: string): FileHost | undefined {
    return this.#runtimes.get(sessionId);
  }

  /**
   * The runtime of an existing session, loading it (not started) when it is not live in this
   * process — e.g. a failed session waiting for Retry, or an ended one.
   */
  async attachable(sessionId: string): Promise<SessionHost | null> {
    return this.#load(sessionId);
  }

  /**
   * Boot restore: end the sessions the previous daemon was still terminating, then start every
   * restorable session (desired running, not a final failure).
   */
  async restore(): Promise<RestoreSummary> {
    // Never restored either way (desired terminated): a failure here must not stop the restore.
    const endedInterrupted = await this.#options.store
      .endInterruptedTerminations()
      .catch((err: unknown) => {
        this.#log.error({ err }, 'ending interrupted terminations failed');
        return 0;
      });
    const records = await this.#options.store.listRestorable();
    const queue = records.filter((r) => !this.#runtimes.has(r.id));
    const restored = queue.length;
    for (const record of queue) this.#pendingRestore.add(record.id);
    const spacing = this.#options.restoreHostSpacingMs ?? RESTORE_HOST_SPACING_MS;
    const nextStart = new Map<string, number>();
    const worker = async (): Promise<void> => {
      for (let record = queue.shift(); record; record = queue.shift()) {
        if (this.#closed) return;
        // Spaced per address: several servers (and users) may point at the same machine.
        const address = `${record.target.hostname}:${record.target.port}`;
        const now = Date.now();
        const at = Math.max(now, nextStart.get(address) ?? 0);
        nextStart.set(address, at + spacing);
        if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
        if (this.#closed) return;
        const { store } = this.#options;
        store.appendEvent(record.id, { type: 'restore_started' });
        // An attach may already have loaded it (with the restored flag, see #load).
        const runtime = this.#runtimes.get(record.id) ?? this.#spawn(record, { restored: true });
        this.#pendingRestore.delete(record.id);
        try {
          await runtime.start();
          const ok = runtime.state === 'ready';
          store.appendEvent(record.id, {
            type: ok ? 'restored' : 'restore_failed',
            ...(ok ? {} : { detail: { state: runtime.state } }),
          });
        } catch (err) {
          this.#log.error({ err, sessionId: record.id }, 'restore failed');
          store.appendEvent(record.id, { type: 'restore_failed' });
        }
      }
    };
    const workers = Math.max(1, this.#options.restoreConcurrency ?? RESTORE_CONCURRENCY);
    await Promise.all(Array.from({ length: workers }, worker));
    return { restored, endedInterrupted };
  }

  /**
   * Starts a newly created session (the internal API inserted the record). Returns at once;
   * the client follows progress through `session.status`.
   */
  create(record: SessionRecord): SessionHost {
    if (this.#closed) throw new TermdockError(ErrorCode.Internal, 'shutting down');
    if (this.#runtimes.has(record.id)) {
      throw new TermdockError(ErrorCode.Conflict, 'session already exists');
    }
    const runtime = this.#spawn(record, {});
    void runtime.start();
    void this.#publishUpsert(record);
    return runtime;
  }

  /**
   * Terminates a session; resolves once it ended or after TERMINATE_ANSWER_MS, whichever comes
   * first (a remote cleanup may take longer, plan D-30: the end then arrives as `session.status`).
   */
  async terminate(sessionId: string, actingUserId: string): Promise<void> {
    const { done } = await this.#beginTerminate(sessionId, actingUserId);
    await settleWithin(done, this.#terminateAnswerMs);
  }

  /**
   * "End all sessions" (plan D-30) and the admin's terminate-sessions: every non-ended session of
   * `userId` starts ending (TERMINATE_ALL_CONCURRENCY at a time; each is `terminating` from its
   * start), then the answer waits for the ends up to TERMINATE_ANSWER_MS in total. Remote
   * cleanups continue after it, REMOTE_CLEANUP_CONCURRENCY at a time. Resolves with how many
   * sessions are ending; sessions that ended or vanished meanwhile are not counted.
   */
  async terminateAll(userId: string): Promise<number> {
    const startedAt = Date.now();
    const live = (await this.listForUser(userId)).filter((s) => s.state !== 'ended');
    const ending: Array<Promise<void>> = [];
    await forEachLimit(live, TERMINATE_ALL_CONCURRENCY, async (session) => {
      try {
        ending.push((await this.#beginTerminate(session.id, userId)).done);
      } catch (err) {
        // Removed meanwhile (not found): nothing left to terminate.
        if (!(err instanceof TermdockError && err.code === ErrorCode.NotFound)) {
          this.#log.warn({ err, sessionId: session.id }, 'terminate failed');
        }
      }
    });
    const left = this.#terminateAnswerMs - (Date.now() - startedAt);
    if (left > 0) await settleWithin(Promise.allSettled(ending), left);
    return ending.length;
  }

  /**
   * Starts a terminate: resolves as soon as the session is `terminating` (the runtime's
   * synchronous part ran), with the rest of the work in `done`. The pin only covers the start:
   * a runtime that is still terminating is never idle, so it is not evicted meanwhile.
   */
  #beginTerminate(sessionId: string, actingUserId: string): Promise<{ done: Promise<void> }> {
    return this.#pinned(sessionId, async () => {
      const runtime = await this.#owned(sessionId, actingUserId);
      const done = runtime.terminate();
      done.catch((err) => this.#log.warn({ err, sessionId }, 'terminate failed'));
      return { done };
    });
  }

  async retry(sessionId: string, actingUserId: string): Promise<void> {
    await this.#pinned(sessionId, async () => {
      const runtime = await this.#owned(sessionId, actingUserId);
      requireServer(await this.#options.store.get(sessionId));
      await runtime.retry();
    });
  }

  /**
   * Remove (plan D-32): deletes an ended session for good (the store checks ownership and the
   * state again, in the write itself). Its runtime, if loaded, goes away; its viewers' channels
   * end with NOT_FOUND and the owner's connections get `session.removed`.
   */
  async remove(sessionId: string, actingUserId: string): Promise<void> {
    const runtime = this.#runtimes.get(sessionId);
    if (runtime && runtime.userId === actingUserId && runtime.state !== 'ended') {
      throw new TermdockError(ErrorCode.Conflict, 'only ended sessions can be removed');
    }
    await this.#options.store.remove(actingUserId, sessionId);
    await this.#forget(sessionId, actingUserId);
  }

  /** "Remove all ended" (plan D-32): resolves with how many sessions were removed. */
  async removeEnded(userId: string): Promise<number> {
    const removed = await this.#options.store.removeEnded(userId);
    for (const sessionId of removed) await this.#forget(sessionId, userId);
    return removed.length;
  }

  async #forget(sessionId: string, userId: string): Promise<void> {
    clearTimeout(this.#evictions.get(sessionId));
    this.#evictions.delete(sessionId);
    const runtime = this.#runtimes.get(sessionId);
    if (runtime) {
      this.#runtimes.delete(sessionId);
      this.#idleSince.delete(sessionId);
      await runtime
        .shutdown()
        .catch((err) => this.#log.warn({ err, sessionId }, 'removed runtime shutdown failed'));
      runtime.dispose();
    }
    const { notifier } = this.#options;
    if (notifier.sessionRemoved) notifier.sessionRemoved(userId, sessionId);
    else notifier.sendToUser(userId, { type: 'session.removed', sessionId });
  }

  /** Stop (plan D-31): ends the session's retry round; CONFLICT when it is not retrying. */
  async stop(sessionId: string, actingUserId: string): Promise<void> {
    await this.#pinned(sessionId, async () => {
      const runtime = await this.#owned(sessionId, actingUserId);
      if (!(await runtime.stopRetrying(actingUserId))) {
        throw new TermdockError(ErrorCode.Conflict, 'the session is not retrying');
      }
    });
  }

  /**
   * New shell, same session id, new runtime (§5.7). Only for ended sessions or protection
   * `none`; attachments move to the new runtime and get a fresh snapshot; seq continues.
   */
  async reopen(sessionId: string, actingUserId: string): Promise<{ sessionId: string }> {
    return this.#pinned(sessionId, () => this.#reopen(sessionId, actingUserId));
  }

  async #reopen(sessionId: string, actingUserId: string): Promise<{ sessionId: string }> {
    const old = await this.#owned(sessionId, actingUserId);
    // A terminate still ending the remote tmux (plan D-30) gets a moment to finish; if it is still
    // running after that, the session is not ended yet and Reopen is refused below.
    const terminating = old.state === 'terminating' ? old.terminating : null;
    if (terminating) {
      await settleWithin(
        terminating.catch(() => {}),
        this.#terminateAnswerMs,
      );
    }
    if (old.state !== 'ended' && old.protection !== 'none') {
      throw new TermdockError(
        ErrorCode.Conflict,
        'only ended or unprotected sessions can be reopened',
      );
    }
    const record = await this.#options.store.get(sessionId);
    if (!record) throw new TermdockError(ErrorCode.NotFound, 'session not found');
    requireServer(record);
    // Same cap as create; checked before anything changes, so a refusal leaves the session as is.
    await this.#options.store.assertRunningCapacity(record.userId, sessionId);
    await old.shutdown();
    const { attachments, activeId, seq } = old.handoff();
    old.dispose();
    this.#runtimes.delete(sessionId);
    this.#idleSince.delete(sessionId);
    const patch = {
      desiredState: 'running' as const,
      state: 'new' as const,
      endedAt: null,
      endReason: null,
      protection: null,
      // A new shell is a new tmux session: compared with the old identity it would read as a
      // remote reboot (§6.10). A surviving tmux server (D-30) is attached either way.
      remoteIdentity: null,
    };
    this.#options.store.update(sessionId, patch);
    this.#options.store.appendEvent(sessionId, { type: 'reopened', actorUserId: actingUserId });
    const runtime = this.#spawn({ ...record, ...patch }, { initialSeq: seq });
    for (const { handle, viewport } of attachments) runtime.attach(handle, viewport);
    if (activeId) runtime.activate(activeId);
    void runtime.start();
    void this.#publishUpsert(record);
    return { sessionId };
  }

  /**
   * The stored label of a session changed (internal API rename; the store checked ownership and
   * committed it): its loaded runtime, if any, takes the new label, and every connection of the
   * owner gets a `session.upsert`, so lists and tabs follow without a reload. A session with no
   * runtime (ended and evicted, or never attached since boot) is only published.
   */
  async renamed(sessionId: string, userId: string, label: string): Promise<void> {
    const runtime = this.#runtimes.get(sessionId);
    if (runtime?.userId === userId) runtime.setLabel(label);
    await this.#publish(sessionId, userId, null);
  }

  /** `sessions.list` for one user: stored summaries with the live runtime state on top. */
  async listForUser(userId: string): Promise<SessionSummary[]> {
    const summaries = await this.#options.store.listForUser(userId);
    return summaries.map((summary) => {
      const runtime = this.#runtimes.get(summary.id);
      return runtime && runtime.userId === userId ? { ...summary, ...runtime.live() } : summary;
    });
  }

  /**
   * Prompts waiting for this user, and the progress of retry rounds in progress (plan D-31: the
   * summary does not carry it), replayed to connections that open later.
   */
  pendingPrompts(userId: string): ServerMessage[] {
    const prompts: ServerMessage[] = [];
    for (const runtime of this.#runtimes.values()) {
      if (runtime.userId !== userId) continue;
      const prompt = runtime.pendingPrompt();
      if (prompt) prompts.push(prompt);
      const retry = runtime.retryStatus();
      if (retry) prompts.push(retry);
    }
    return prompts;
  }

  /** Callers must have checked that `userId` owns the session. */
  async hostKeyDecision(
    sessionId: string,
    fingerprint: string,
    accept: boolean,
    userId: string,
  ): Promise<boolean> {
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime || runtime.userId !== userId) return false;
    return runtime.hostKeyDecision(fingerprint, accept, userId);
  }

  /** Callers must have checked ownership. Answers are never logged. */
  authResponse(sessionId: string, promptId: string, answers: string[], userId: string): boolean {
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime || runtime.userId !== userId) return false;
    return runtime.authResponse(promptId, answers);
  }

  get size(): number {
    return this.#runtimes.size;
  }

  /** Graceful shutdown of every runtime, bounded by the shutdown budget. */
  async shutdown(budgetMs = SHUTDOWN_BUDGET_MS): Promise<void> {
    this.#closed = true;
    for (const eviction of this.#evictions.values()) clearTimeout(eviction);
    this.#evictions.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    });
    const all = Promise.allSettled([...this.#runtimes.values()].map((r) => r.shutdown()));
    await Promise.race([all, budget]);
    clearTimeout(timer);
  }

  #spawn(
    record: SessionRecord,
    extra: Pick<SessionRuntimeOptions, 'restored' | 'initialSeq'>,
  ): SessionRuntime {
    const { store, hostKeys, transports, drivers, notifier, installationId } = this.#options;
    const runtime = new SessionRuntime({
      record,
      store,
      hostKeys,
      transports,
      drivers,
      notifier,
      installationId,
      logger: this.#log,
      onSummaryChange: () => void this.#publishUpsert(record),
      onIdle: () => this.#scheduleEviction(record.id),
      cleanupSlot: (task, signal) => this.#cleanups.run(task, signal),
      ...(this.#options.sweeper ? { sweeper: this.#options.sweeper } : {}),
      ...this.#options.runtime,
      ...extra,
    });
    this.#runtimes.set(record.id, runtime);
    return runtime;
  }

  /**
   * (Re)starts the idle timer of a session's runtime (the check happens when it fires), and keeps
   * its user within the idle cap: called whenever the runtime is idle after a load, a detach, an
   * end or an operation.
   */
  #scheduleEviction(sessionId: string): void {
    if (this.#closed) return;
    clearTimeout(this.#evictions.get(sessionId));
    const timer = setTimeout(() => {
      if (this.#evictions.get(sessionId) === timer) this.#evictions.delete(sessionId);
      this.#evict(sessionId);
    }, this.#idleTtlMs);
    timer.unref?.();
    this.#evictions.set(sessionId, timer);
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime) return;
    this.#idleSince.set(sessionId, ++this.#idleSeq);
    this.#capIdle(runtime.userId, sessionId);
  }

  /**
   * Evicts the least recently idle runtimes of `userId` at once while the user has more idle
   * runtimes than the cap. Pinned ones and `keep` (the one that just became idle) count but stay;
   * attached ones and those meant to run are not idle. Other users are untouched.
   */
  #capIdle(userId: string, keep: string): void {
    let idle = 0;
    const evictable: Array<[sessionId: string, since: number]> = [];
    for (const [id, runtime] of this.#runtimes) {
      if (runtime.userId !== userId || !runtime.idle) continue;
      idle++;
      if (id !== keep && !this.#pins.has(id)) evictable.push([id, this.#idleSince.get(id) ?? 0]);
    }
    if (idle <= this.#maxIdlePerUser) return;
    evictable.sort((a, b) => a[1] - b[1]);
    for (const [id] of evictable.slice(0, idle - this.#maxIdlePerUser)) {
      clearTimeout(this.#evictions.get(id));
      this.#evictions.delete(id);
      this.#evict(id);
    }
  }

  #evict(sessionId: string): void {
    const runtime = this.#runtimes.get(sessionId);
    if (this.#closed || !runtime?.idle || this.#pins.has(sessionId)) return;
    // Out of the map first: from now on an attach loads the session again.
    this.#runtimes.delete(sessionId);
    this.#idleSince.delete(sessionId);
    void runtime
      .shutdown()
      .catch((err) => this.#log.warn({ err, sessionId }, 'evicted runtime shutdown failed'))
      .finally(() => runtime.dispose());
  }

  /** Runs a registry operation with the session's runtime protected from eviction. */
  async #pinned<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    this.#pins.set(sessionId, (this.#pins.get(sessionId) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const left = (this.#pins.get(sessionId) ?? 1) - 1;
      if (left > 0) this.#pins.set(sessionId, left);
      else this.#pins.delete(sessionId);
      // An eviction skipped while pinned would never come back: re-arm it.
      if (left === 0 && this.#runtimes.get(sessionId)?.idle) this.#scheduleEviction(sessionId);
    }
  }

  async #load(sessionId: string): Promise<SessionRuntime | null> {
    const live = this.#runtimes.get(sessionId);
    if (live) return live;
    if (this.#closed) return null;
    let loading = this.#loading.get(sessionId);
    if (!loading) {
      loading = this.#options.store
        .get(sessionId)
        .then((record) => {
          if (!record) return null;
          const live = this.#runtimes.get(sessionId);
          if (live) return live;
          const restored = this.#pendingRestore.has(sessionId);
          const runtime = this.#spawn(record, { restored });
          // Loaded for an attach or an operation: unless it gets used, it is idle from now.
          if (runtime.idle) this.#scheduleEviction(sessionId);
          return runtime;
        })
        .finally(() => this.#loading.delete(sessionId));
      this.#loading.set(sessionId, loading);
    }
    return loading;
  }

  /** Re-validates ownership (defense in depth, plan §4.4); a foreign session is "not found". */
  async #owned(sessionId: string, actingUserId: string): Promise<SessionRuntime> {
    const runtime = await this.#load(sessionId);
    if (!runtime || runtime.userId !== actingUserId) {
      throw new TermdockError(ErrorCode.NotFound, 'session not found');
    }
    return runtime;
  }

  async #publishUpsert(record: SessionRecord): Promise<void> {
    await this.#publish(record.id, record.userId, () => this.#fallbackSummary(record));
  }

  /** `session.upsert` of the stored summary (live state on top), or of `fallback` when unlisted. */
  async #publish(
    sessionId: string,
    userId: string,
    fallback: (() => SessionSummary) | null,
  ): Promise<void> {
    try {
      const summaries = await this.listForUser(userId);
      const session = summaries.find((s) => s.id === sessionId) ?? fallback?.();
      if (session) this.#options.notifier.sendToUser(userId, { type: 'session.upsert', session });
    } catch (err) {
      this.#log.warn({ err, sessionId }, 'session.upsert failed');
    }
  }

  #fallbackSummary(record: SessionRecord): SessionSummary {
    const runtime = this.#runtimes.get(record.id);
    return {
      id: record.id,
      // The runtime's copy follows renames; `record` is the one the runtime was spawned from.
      label: runtime?.label ?? record.label,
      serverId: record.serverId,
      // The server's name is not part of the record: the snapshotted hostname stands in, as for
      // a session whose server is gone.
      serverName: record.target.hostname,
      kind: record.target.kind,
      hostname: record.target.hostname,
      port: record.target.port,
      username: record.target.username,
      createdAt: record.createdAt,
      statusDetail: null,
      ...(runtime
        ? runtime.live()
        : {
            state: record.state,
            status: record.status,
            protection: record.protection,
            lastReadyAt: record.lastReadyAt,
            endedAt: record.endedAt,
            endReason: record.endReason,
          }),
    };
  }
}
