import type { ServerMessage, SessionSummary } from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { type Logger, silentLogger } from '../config/logger.ts';
import type { DriverFactory } from './driver-factory.ts';
import {
  SessionRuntime,
  type SessionRuntimeOptions,
  type UserNotifier,
} from './session-runtime.ts';
import type { TransportFactory } from './transport-factory.ts';
import type { HostKeyStore, SessionHost, SessionRecord, SessionStore } from './types.ts';

/** Boot restore (plan §5.8): at most 4 connects at once, spaced per host. */
export const RESTORE_CONCURRENCY = 4;
export const RESTORE_HOST_SPACING_MS = 500;
/** Daemon shutdown budget for the runtimes (inside compose's 30 s grace period). */
export const SHUTDOWN_BUDGET_MS = 20_000;

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
  /** Extra runtime options (timings in tests). */
  runtime?: Partial<
    Pick<
      SessionRuntimeOptions,
      'promptTimeoutMs' | 'resizeDebounceMs' | 'lagPollMs' | 'ingestPollMs' | 'random' | 'now'
    >
  >;
}

/**
 * Owns every session runtime of the process. The internal API (create/terminate/retry/reopen)
 * and the WebSocket server reach sessions only through here.
 */
export class SessionRegistry {
  readonly #options: SessionRegistryOptions;
  readonly #runtimes = new Map<string, SessionRuntime>();
  readonly #loading = new Map<string, Promise<SessionRuntime | null>>();
  /** Sessions queued for boot restore and not started yet. */
  readonly #pendingRestore = new Set<string>();
  readonly #log: Logger;
  #closed = false;

  constructor(options: SessionRegistryOptions) {
    this.#options = options;
    this.#log = options.logger ?? silentLogger();
  }

  /** A loaded runtime, or undefined. */
  host(sessionId: string): SessionRuntime | undefined {
    return this.#runtimes.get(sessionId);
  }

  /**
   * The runtime of an existing session, loading it (not started) when it is not live in this
   * process — e.g. a failed session waiting for Retry, or an ended one.
   */
  async attachable(sessionId: string): Promise<SessionHost | null> {
    return this.#load(sessionId);
  }

  /** Boot restore: start every restorable session (desired running, not a final failure). */
  async restore(): Promise<void> {
    const records = await this.#options.store.listRestorable();
    const queue = records.filter((r) => !this.#runtimes.has(r.id));
    for (const record of queue) this.#pendingRestore.add(record.id);
    const spacing = this.#options.restoreHostSpacingMs ?? RESTORE_HOST_SPACING_MS;
    const nextStart = new Map<string, number>();
    const worker = async (): Promise<void> => {
      for (let record = queue.shift(); record; record = queue.shift()) {
        if (this.#closed) return;
        const host = record.target.hostId ?? `${record.target.hostname}:${record.target.port}`;
        const now = Date.now();
        const at = Math.max(now, nextStart.get(host) ?? 0);
        nextStart.set(host, at + spacing);
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

  async terminate(sessionId: string, actingUserId: string): Promise<void> {
    const runtime = await this.#owned(sessionId, actingUserId);
    await runtime.terminate();
  }

  async retry(sessionId: string, actingUserId: string): Promise<void> {
    const runtime = await this.#owned(sessionId, actingUserId);
    await runtime.retry();
  }

  /**
   * New shell, same session id, new runtime (§5.7). Only for ended sessions or protection
   * `none`; attachments move to the new runtime and get a fresh snapshot; seq continues.
   */
  async reopen(sessionId: string, actingUserId: string): Promise<{ sessionId: string }> {
    const old = await this.#owned(sessionId, actingUserId);
    if (old.state !== 'ended' && old.protection !== 'none') {
      throw new TermdockError(
        ErrorCode.Conflict,
        'only ended or unprotected sessions can be reopened',
      );
    }
    const record = await this.#options.store.get(sessionId);
    if (!record) throw new TermdockError(ErrorCode.NotFound, 'session not found');
    await old.shutdown();
    const { attachments, activeId, seq } = old.handoff();
    old.dispose();
    this.#runtimes.delete(sessionId);
    const patch = {
      desiredState: 'running' as const,
      state: 'new' as const,
      endedAt: null,
      endReason: null,
      protection: null,
    };
    this.#options.store.update(sessionId, patch);
    this.#options.store.appendEvent(sessionId, { type: 'reopened', actorUserId: actingUserId });
    const runtime = this.#spawn({ ...record, ...patch }, { initialSeq: seq });
    for (const { handle, viewport } of attachments) runtime.attach(handle, viewport);
    if (activeId) runtime.activate(activeId);
    void runtime.start();
    return { sessionId };
  }

  /** `sessions.list` for one user: stored summaries with the live runtime state on top. */
  async listForUser(userId: string): Promise<SessionSummary[]> {
    const summaries = await this.#options.store.listForUser(userId);
    return summaries.map((summary) => {
      const runtime = this.#runtimes.get(summary.id);
      return runtime && runtime.userId === userId ? { ...summary, ...runtime.live() } : summary;
    });
  }

  /** Prompts waiting for this user (replayed to connections that open later). */
  pendingPrompts(userId: string): ServerMessage[] {
    const prompts: ServerMessage[] = [];
    for (const runtime of this.#runtimes.values()) {
      if (runtime.userId !== userId) continue;
      const prompt = runtime.pendingPrompt();
      if (prompt) prompts.push(prompt);
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
      ...this.#options.runtime,
      ...extra,
    });
    this.#runtimes.set(record.id, runtime);
    return runtime;
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
          const restored = this.#pendingRestore.has(sessionId);
          return this.#runtimes.get(sessionId) ?? this.#spawn(record, { restored });
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
    try {
      const summaries = await this.listForUser(record.userId);
      const session = summaries.find((s) => s.id === record.id) ?? this.#fallbackSummary(record);
      this.#options.notifier.sendToUser(record.userId, { type: 'session.upsert', session });
    } catch (err) {
      this.#log.warn({ err, sessionId: record.id }, 'session.upsert failed');
    }
  }

  #fallbackSummary(record: SessionRecord): SessionSummary {
    const runtime = this.#runtimes.get(record.id);
    return {
      id: record.id,
      label: record.label,
      profileId: null,
      hostId: record.target.hostId,
      hostName: record.target.hostname,
      hostname: record.target.hostname,
      username: record.target.username,
      createdAt: record.createdAt,
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
