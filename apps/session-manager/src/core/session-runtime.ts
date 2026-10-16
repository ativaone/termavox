import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import {
  AUTH_PROMPT_LIMITS,
  type EndReason,
  isControlChar,
  isInvisibleFormatChar,
  type Protection,
  type ServerMessage,
  type SessionState,
  type SessionStatus,
  toSessionStatus,
} from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { Attachment } from '../attachments/attachment.ts';
import { RESIZE_DEBOUNCE_MS, SizePolicy, sameSize } from '../attachments/size-policy.ts';
import {
  type ChannelMessage,
  encodeChannelMessage,
  encodeSnapshotFrame,
} from '../attachments/wire.ts';
import { type Logger, silentLogger } from '../config/logger.ts';
import { HeadlessEmulator } from '../emulator/headless-emulator.ts';
import { type ProbeResult, runProbe, storableProbe } from '../probe/index.ts';
import type { KeyboardInteractiveRequest } from '../transport/ssh/index.ts';
import { backoffDelay } from './backoff.ts';
import { type DriverFactory, tmuxSocketName } from './driver-factory.ts';
import { selectProtection } from './protection.ts';
import type { TransportFactory, TransportHooks } from './transport-factory.ts';
import {
  type AttachmentClient,
  type AttachmentHandle,
  BadLaunchParamsError,
  type Dimensions,
  type Driver,
  type DriverContext,
  type Emulator,
  type HostKeyStore,
  type PresentedHostKey,
  type RemoteIdentity,
  type SessionHost,
  type SessionRecord,
  type SessionStore,
  type Transport,
  TransportError,
} from './types.ts';

const gzipAsync = promisify(gzip);
const encoder = new TextEncoder();

/** Keyboard-interactive prompt lifetime, below OpenSSH's LoginGraceTime of 120 s (§5.10). */
export const PROMPT_TIMEOUT_MS = 100_000;
/** Emulator ingest backpressure (plan §5.5). */
export const INGEST_HIGH_WATER = 8 * 1024 * 1024;
export const INGEST_LOW_WATER = 1024 * 1024;
const INGEST_POLL_MS = 10;
const PROBE_TIMEOUT_MS = 15_000;
const MAX_TITLE_LENGTH = 256;
/**
 * Written before a new shell starts in an emulator that kept the previous screen: leave the
 * alternate screen, soft reset (DECSTR), and turn off mouse reporting and bracketed paste that
 * the lost program may have left enabled.
 */
const NEW_SHELL_RESET =
  '\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h';

/** Delivers user-scoped messages (status, prompts) to every connection of a user. */
export interface UserNotifier {
  sendToUser(userId: string, message: ServerMessage): void;
}

export interface SessionRuntimeOptions {
  record: SessionRecord;
  store: SessionStore;
  hostKeys: HostKeyStore;
  transports: TransportFactory;
  drivers: DriverFactory;
  notifier: UserNotifier;
  installationId: string;
  logger?: Logger;
  /** Continues the session's seq (reopen within the same process, §5.4). */
  initialSeq?: number;
  /** Started by boot restore: the previous shell of a `none` session is gone (§5.7). */
  restored?: boolean;
  random?: () => number;
  now?: () => number;
  promptTimeoutMs?: number;
  resizeDebounceMs?: number;
  lagPollMs?: number;
  ingestPollMs?: number;
  /**
   * A field of the session's summary changed (protection, end, first ready): the registry
   * publishes `session.upsert`, so the bay never waits for a reload.
   */
  onSummaryChange?: () => void;
  /** The runtime may have become `idle`: the registry schedules its eviction. */
  onIdle?: () => void;
}

/** Live fields the registry overlays on stored session summaries. */
export interface LiveSessionFields {
  state: SessionState;
  status: SessionStatus;
  protection: Protection | null;
  lastReadyAt: number | null;
  endedAt: number | null;
  endReason: EndReason | null;
  /** Absent until this runtime changed state: the stored summary's value stands until then. */
  statusDetail?: string | null;
}

interface Snapshot {
  seq: number;
  cols: number;
  rows: number;
  gzipped: Uint8Array;
}

type Outcome = 'ready' | 'retry' | 'park' | 'stopped' | 'exited';
type LifeEnd = 'lost' | 'exited' | 'stopped';

interface AuthPrompt {
  id: string;
  message: ServerMessage;
  timer: ReturnType<typeof setTimeout>;
  resolve(answers: string[] | null): void;
}

/**
 * One session's runtime (plan §5.1): state machine and connect loop, the authoritative emulator,
 * the output pipeline with sequencing and snapshots, the size policy and attachment fan-out.
 */
export class SessionRuntime implements SessionHost {
  readonly #record: SessionRecord;
  readonly #store: SessionStore;
  readonly #hostKeys: HostKeyStore;
  readonly #transports: TransportFactory;
  readonly #drivers: DriverFactory;
  readonly #notifier: UserNotifier;
  readonly #installationId: string;
  readonly #log: Logger;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #promptTimeoutMs: number;
  readonly #lagPollMs: number | undefined;
  readonly #ingestPollMs: number;
  readonly #restored: boolean;
  readonly #onSummaryChange: () => void;
  readonly #onIdle: () => void;

  #state: SessionState;
  /** `detail` of the latest state change in this process (undefined before the first one). */
  #statusDetail: string | null | undefined = undefined;
  #wasReady: boolean;
  #desired: 'running' | 'terminated';
  #protection: Protection | null;
  #closed = false;
  #started = false;
  #terminating = false;
  /** terminate() is still tearing the remote down. */
  #terminateInFlight = false;

  // connect loop
  #generation = 0;
  #loopRunning = false;
  #wake: (() => void) | null = null;
  #abort: AbortController | null = null;
  #life: PromiseWithResolvers<LifeEnd> | null = null;
  readonly #firstAttempt = Promise.withResolvers<void>();
  #transport: Transport | null = null;
  #driver: Driver | null = null;
  #pendingHostKey: PresentedHostKey | null = null;
  #mismatchKey: { type: string; fingerprint: string; revoked: boolean } | null = null;
  #authPrompt: AuthPrompt | null = null;
  #promptExpired = false;
  #bannerBeforeStart: string | null = null;
  #resetBeforeStart = false;
  /** Out-of-band notice carried by the next `ready` status (tmux-control remote reboot). */
  #readyDetail: string | null = null;
  /** Generation whose driver confirmed that the shell exited (has-session: gone). */
  #exitedGen = -1;

  // output pipeline
  #emulator: HeadlessEmulator;
  #emulatorAnswers: boolean;
  #seq: number;
  /** Bumped by every state change that does not advance seq (resize, emulator swap). */
  #stateGen = 0;
  #snapshotCache: { key: string; promise: Promise<Snapshot> } | null = null;
  readonly #attachments = new Map<string, Attachment>();
  readonly #policy: SizePolicy;
  #lastActive: string | null = null;
  #ingestPaused = false;
  #ingestTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SessionRuntimeOptions) {
    this.#record = structuredClone(options.record);
    this.#store = options.store;
    this.#hostKeys = options.hostKeys;
    this.#transports = options.transports;
    this.#drivers = options.drivers;
    this.#notifier = options.notifier;
    this.#installationId = options.installationId;
    this.#log = (options.logger ?? silentLogger()).child({ sessionId: options.record.id });
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#promptTimeoutMs = options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS;
    this.#lagPollMs = options.lagPollMs;
    this.#ingestPollMs = options.ingestPollMs ?? INGEST_POLL_MS;
    this.#restored = options.restored ?? false;
    this.#onSummaryChange = options.onSummaryChange ?? (() => {});
    this.#onIdle = options.onIdle ?? (() => {});
    this.#seq = options.initialSeq ?? 0;
    this.#state = this.#record.state;
    this.#wasReady = this.#record.lastReadyAt !== null;
    this.#desired = this.#record.desiredState;
    this.#protection = this.#record.protection;
    this.#emulatorAnswers = this.#protection !== 'tmux-control';
    this.#emulator = this.#createEmulator(
      { cols: this.#record.cols, rows: this.#record.rows },
      this.#emulatorAnswers,
    );
    this.#policy = new SizePolicy(
      () => this.#onPolicyChange(),
      options.resizeDebounceMs ?? RESIZE_DEBOUNCE_MS,
    );
  }

  // ── accessors ────────────────────────────────────────────────────────────────

  get sessionId(): string {
    return this.#record.id;
  }

  get userId(): string {
    return this.#record.userId;
  }

  get state(): SessionState {
    return this.#state;
  }

  get protection(): Protection | null {
    return this.#protection;
  }

  /** Last assigned output seq. */
  get seq(): number {
    return this.#seq;
  }

  /** The authoritative emulator (diagnostics and tests; only the runtime writes to it). */
  get emulator(): HeadlessEmulator {
    return this.#emulator;
  }

  get attachmentCount(): number {
    return this.#attachments.size;
  }

  /**
   * Nothing runs (the session is not meant to run, no connect loop, no terminate in progress)
   * and nobody is attached: the registry may evict the runtime after its idle TTL.
   */
  get idle(): boolean {
    return (
      !this.#closed &&
      this.#desired !== 'running' &&
      this.#attachments.size === 0 &&
      !this.#loopRunning &&
      !this.#terminateInFlight
    );
  }

  live(): LiveSessionFields {
    return {
      state: this.#state,
      status: toSessionStatus(this.#state, this.#wasReady),
      protection: this.#protection,
      lastReadyAt: this.#record.lastReadyAt,
      endedAt: this.#record.endedAt,
      endReason: this.#record.endReason,
      ...(this.#statusDetail !== undefined ? { statusDetail: this.#statusDetail } : {}),
    };
  }

  /** The prompt a user must answer for this session, for clients that connect later. */
  pendingPrompt(): ServerMessage | null {
    if (this.#state === 'awaiting_host_key' && this.#pendingHostKey) {
      return this.#hostKeyPrompt(this.#pendingHostKey, false);
    }
    if (this.#state === 'failed' && this.#mismatchKey) {
      return this.#hostKeyPrompt(this.#mismatchKey, true);
    }
    return this.#authPrompt?.message ?? null;
  }

  // ── lifecycle (SessionHost) ─────────────────────────────────────────────────

  /** Starts the connect loop; resolves once the first connect attempt settled. */
  async start(): Promise<void> {
    if (this.#started || this.#closed) return this.#firstAttempt.promise;
    this.#started = true;
    if (this.#state === 'ended' || this.#desired !== 'running') {
      this.#firstAttempt.resolve();
      return;
    }
    if (this.#restored && this.#protection === 'none') {
      await this.#refreshPolicies();
      if (!this.#record.policies.autoReopen) {
        this.#end('service_restarted');
        this.#firstAttempt.resolve();
        return;
      }
      this.#bannerBeforeStart = 'Termdock restarted';
    }
    this.#kick();
    return this.#firstAttempt.promise;
  }

  /** User Retry: reconnect now (skips a pending backoff wait). */
  async retry(): Promise<void> {
    if (this.#closed || this.#desired !== 'running' || this.#state === 'ready') return;
    this.#mismatchKey = null;
    this.#kick();
  }

  async terminate(): Promise<void> {
    if (this.#state === 'ended' || this.#terminating || this.#closed) return;
    this.#terminating = true;
    this.#terminateInFlight = true;
    try {
      this.#desired = 'terminated';
      this.#store.update(this.sessionId, { desiredState: 'terminated' });
      this.#setState('terminating');
      const driver = this.#driver;
      const transport = this.#transport;
      this.#stopActivity();
      if (driver) await driver.terminate().catch((err) => this.#warn('driver terminate', err));
      if (transport) await closeQuietly(transport);
      this.#end('user_terminated');
    } finally {
      this.#terminateInFlight = false;
      this.#maybeIdle();
    }
  }

  /** Graceful daemon shutdown: protected remotes stay alive; persisted state is kept. */
  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const driver = this.#driver;
    const transport = this.#transport;
    this.#stopActivity();
    if (driver) await driver.detach().catch((err) => this.#warn('driver detach', err));
    if (transport) await closeQuietly(transport);
    for (const attachment of this.#attachments.values()) attachment.dispose();
    this.#policy.dispose();
  }

  /** Hands the attachments and the seq over to a replacement runtime (reopen). */
  handoff(): {
    attachments: Array<{ handle: AttachmentHandle; viewport: Dimensions }>;
    activeId: string | null;
    seq: number;
  } {
    const attachments = [...this.#attachments.values()].map((a) => ({
      handle: a.handle,
      viewport: a.viewport,
    }));
    for (const attachment of this.#attachments.values()) attachment.dispose();
    const activeId = this.#policy.active;
    this.#attachments.clear();
    return { attachments, activeId, seq: this.#seq };
  }

  dispose(): void {
    this.#emulator.dispose();
  }

  // ── user decisions ──────────────────────────────────────────────────────────

  /** Host-key prompt answer (§5.9): accept trusts exactly the pending key, then reconnects. */
  async hostKeyDecision(fingerprint: string, accept: boolean, userId: string): Promise<boolean> {
    const pending = this.#pendingHostKey;
    if (this.#state !== 'awaiting_host_key' || pending?.fingerprint !== fingerprint) return false;
    this.#pendingHostKey = null;
    const detail = { keyType: pending.type, fingerprint };
    if (!accept) {
      this.#event('host_key_rejected', detail, userId);
      this.#setState('failed', { detail: ErrorCode.HostKeyRejected });
      return true;
    }
    const hostId = this.#record.target.hostId;
    const trusted = hostId
      ? await this.#hostKeys.trustPending(hostId, fingerprint, userId).catch((err) => {
          this.#warn('trust pending host key', err);
          return false;
        })
      : false;
    // An expired pending row trusts nothing: the reconnect simply prompts again.
    this.#event(trusted ? 'host_key_trusted' : 'host_key_expired', detail, userId);
    this.#kick();
    return true;
  }

  /** Keyboard-interactive answers (§5.10). Stale prompt ids are discarded. */
  authResponse(promptId: string, answers: string[]): boolean {
    const prompt = this.#authPrompt;
    if (!prompt || prompt.id !== promptId) return false;
    clearTimeout(prompt.timer);
    this.#authPrompt = null;
    this.#setState('authenticating');
    prompt.resolve(answers);
    return true;
  }

  // ── attachments (SessionHost) ───────────────────────────────────────────────

  attach(handle: AttachmentHandle, viewport: Dimensions, client?: AttachmentClient): void {
    if (this.#closed) return;
    if (this.#attachments.has(handle.id)) this.detach(handle.id);
    if (client) this.#clientEvent('attached', handle.id, client);
    const attachment = new Attachment(handle, viewport, {
      onRecovered: (a) => this.#resync(a),
      ...(this.#lagPollMs !== undefined ? { lagPollMs: this.#lagPollMs } : {}),
    });
    this.#attachments.set(attachment.id, attachment);
    this.#policy.add(attachment.id, viewport);
    handle.send(
      encodeChannelMessage({
        type: 'session.attached',
        sessionId: this.sessionId,
        cols: this.#emulator.cols,
        rows: this.#emulator.rows,
        scrollbackLines: this.#record.scrollbackLines,
      }),
    );
    this.#resync(attachment);
    // An expired keyboard-interactive prompt waits for someone who can answer (§5.10).
    if (this.#state === 'awaiting_user_input' && !this.#authPrompt) this.#kick();
  }

  detach(attachmentId: string, client?: AttachmentClient): void {
    const attachment = this.#attachments.get(attachmentId);
    if (!attachment) return;
    if (client) this.#clientEvent('detached', attachmentId, client);
    attachment.dispose();
    this.#attachments.delete(attachmentId);
    this.#policy.remove(attachmentId);
    this.#maybeIdle();
  }

  input(attachmentId: string, data: Uint8Array): void {
    if (!this.#attachments.has(attachmentId)) return;
    this.#policy.activate(attachmentId);
    if (this.#state === 'ready') this.#driver?.input(data);
  }

  activate(attachmentId: string): void {
    this.#policy.activate(attachmentId);
  }

  viewport(attachmentId: string, dims: Dimensions): void {
    const attachment = this.#attachments.get(attachmentId);
    if (!attachment) return;
    attachment.viewport = dims;
    this.#policy.viewport(attachmentId, dims);
  }

  resync(attachmentId: string): void {
    const attachment = this.#attachments.get(attachmentId);
    if (attachment) this.#resync(attachment);
  }

  // ── connect loop ────────────────────────────────────────────────────────────

  #kick(): void {
    if (this.#closed || this.#desired !== 'running') return;
    if (this.#wake) {
      this.#wake();
      return;
    }
    if (this.#loopRunning) return;
    this.#loopRunning = true;
    void this.#runLoop()
      .catch((err) => this.#log.error({ err }, 'connect loop crashed'))
      .finally(() => {
        this.#loopRunning = false;
        this.#firstAttempt.resolve();
        this.#maybeIdle();
      });
  }

  async #runLoop(): Promise<void> {
    let failures = 0;
    while (!this.#closed && this.#desired === 'running') {
      const outcome = await this.#attempt();
      this.#firstAttempt.resolve();
      if (outcome === 'stopped' || outcome === 'park') return;
      if (outcome === 'exited') {
        this.#end('shell_exited');
        return;
      }
      if (outcome === 'ready') {
        failures = 0;
        const end = await this.#life!.promise;
        // Whoever stopped the session (terminate/shutdown) owns the teardown.
        if (end === 'stopped' || this.#closed || this.#desired !== 'running') return;
        const lostAt = this.#now();
        await this.#teardownAttempt();
        if (end === 'exited') {
          this.#end('shell_exited');
          return;
        }
        this.#event('connection_lost');
        if (this.#protection !== 'tmux-control') {
          await this.#refreshPolicies();
          if (!this.#record.policies.autoReopen) {
            this.#end('connection_lost');
            return;
          }
          this.#bannerBeforeStart = `connection lost at ${formatClock(lostAt)} · new shell started (session not protected)`;
          this.#resetBeforeStart = true;
        }
      }
      const delay = backoffDelay(failures++, this.#random);
      this.#setState('reconnecting', { retryInMs: delay });
      await this.#sleep(delay);
    }
  }

  async #attempt(): Promise<Outcome> {
    const gen = ++this.#generation;
    const life = Promise.withResolvers<LifeEnd>();
    this.#life = life;
    this.#promptExpired = false;
    await this.#refreshPolicies();
    if (gen !== this.#generation) return 'stopped';
    this.#setState('connecting');

    const abort = new AbortController();
    this.#abort = abort;
    let transport: Transport | null = null;
    try {
      transport = await this.#transports.create(this.#record, this.#hooks(gen));
      if (gen !== this.#generation) {
        await closeQuietly(transport);
        return 'stopped';
      }
      this.#transport = transport;
      const own = transport;
      own.onLost((err) => {
        if (this.#transport !== own) return;
        this.#log.info({ code: err.code }, 'transport lost');
        life.resolve('lost');
      });
      await own.connect(abort.signal);
    } catch (err) {
      if (transport) await closeQuietly(transport);
      if (this.#transport === transport) this.#transport = null;
      if (gen !== this.#generation) return 'stopped';
      return this.#connectFailed(err);
    } finally {
      if (this.#abort === abort) this.#abort = null;
    }
    if (gen !== this.#generation) return 'stopped';

    try {
      this.#setState('probing');
      const probe = await runProbe(transport, PROBE_TIMEOUT_MS);
      if (gen !== this.#generation) return 'stopped';
      this.#store.update(this.sessionId, {
        probe: storableProbe(probe.raw),
        tmuxVersion: probe.tmuxVersionRaw,
      });
      const choice = this.#chooseProtection(probe);
      await this.#ensureEmulatorMode(choice.protection !== 'tmux-control');
      if (gen !== this.#generation) return 'stopped';
      const driver = this.#createDriver(choice.protection, probe, gen);
      this.#setState('starting', choice.notice ? { detail: choice.notice } : {});
      if (choice.degraded) {
        this.#bannerBeforeStart = `${choice.notice ?? 'tmux unavailable'} · new shell started`;
        this.#resetBeforeStart = true;
      }
      if (this.#bannerBeforeStart) {
        if (this.#resetBeforeStart) this.#output(encoder.encode(NEW_SHELL_RESET));
        this.#banner(this.#bannerBeforeStart);
        this.#bannerBeforeStart = null;
        this.#resetBeforeStart = false;
      }
      this.#driver = driver;
      this.#setIngestPaused(false);
      const startSize = this.#startSize();
      await driver.start(this.#context(transport, gen, life), startSize);
      if (gen !== this.#generation) return 'stopped';
      if (this.#protection !== 'tmux-control' && !sameSize(startSize, this.#size)) {
        driver.resize(this.#size); // a resize landed while the PTY was opening
      }
      this.#markReady();
      this.#onPolicyChange();
      return 'ready';
    } catch (err) {
      if (gen !== this.#generation) return 'stopped';
      this.#driver = null;
      this.#transport = null;
      await closeQuietly(transport);
      // start() may reject and the driver confirm a shell exit for the same attempt (ADR-0003):
      // one outcome per attempt, and a confirmed exit wins over a retry.
      if (this.#exitedGen === gen) return 'exited';
      this.#warn('session start failed', err);
      // A profile or probe value the launch cannot pass safely: every retry would log in to
      // the host again only to fail the same way, so the session waits for the user instead.
      if (err instanceof BadLaunchParamsError) {
        this.#fail(ErrorCode.BadLaunchParams);
        return 'park';
      }
      return 'retry';
    }
  }

  async #connectFailed(err: unknown): Promise<Outcome> {
    if (err instanceof TermdockError) {
      switch (err.code) {
        case ErrorCode.HostKeyRejected: {
          const pending = err.details?.pending as PresentedHostKey | undefined;
          if (pending && this.#record.target.hostId) {
            await this.#awaitHostKey(this.#record.target.hostId, pending);
            return 'park';
          }
          this.#fail(err.code);
          return 'park';
        }
        case ErrorCode.HostKeyMismatch: {
          const presented = err.details?.presented as
            | { type: string; fingerprint: string }
            | undefined;
          // A key the owner revoked fails closed exactly like any other mismatch (§5.9).
          const revoked = err.details?.revoked === true;
          this.#mismatchKey = presented ? { ...presented, revoked } : null;
          this.#event(
            revoked ? 'host_key_revoked_presented' : 'host_key_mismatch',
            presented ? { keyType: presented.type, fingerprint: presented.fingerprint } : {},
          );
          this.#fail(err.code);
          if (this.#mismatchKey) this.#notify(this.#hostKeyPrompt(this.#mismatchKey, true));
          return 'park';
        }
        case ErrorCode.AuthTimeout:
          if (this.#promptExpired) {
            // Stays in awaiting_user_input; the next attempt starts on attach or Retry.
            this.#event('auth_prompt_expired');
            return 'park';
          }
          return 'retry';
        case ErrorCode.AuthRejected:
        case ErrorCode.CredentialInvalid:
        case ErrorCode.LocalShellDisabled:
        case ErrorCode.TargetNotAllowed:
        case ErrorCode.NotFound:
        case ErrorCode.Forbidden:
          this.#fail(err.code);
          return 'park';
        default:
          return 'retry';
      }
    }
    if (err instanceof TransportError && !err.retryable) {
      this.#fail(err.code);
      return 'park';
    }
    this.#log.info({ err: describeError(err) }, 'connect attempt failed');
    return 'retry';
  }

  async #awaitHostKey(hostId: string, key: PresentedHostKey): Promise<void> {
    await this.#hostKeys
      .recordPending(hostId, key)
      .catch((err) => this.#warn('record pending host key', err));
    this.#pendingHostKey = key;
    this.#setState('awaiting_host_key');
    this.#event('host_key_unknown', { keyType: key.type, fingerprint: key.fingerprint });
    this.#notify(this.#hostKeyPrompt(key, false));
  }

  #hooks(gen: number): TransportHooks {
    return {
      onHostKey: (_key, decision) => {
        if (gen !== this.#generation) return;
        this.#setState('verifying_host');
        if (decision === 'trusted') this.#setState('authenticating');
      },
      onKeyboardInteractive: (request) => this.#promptUser(request, gen),
    };
  }

  #promptUser(request: KeyboardInteractiveRequest, gen: number): Promise<string[] | null> {
    if (gen !== this.#generation) return Promise.resolve(null);
    this.#cancelPrompt();
    // More prompts than the protocol carries cannot be answered positionally: the round is
    // refused (the transport reports AUTH_REJECTED).
    if (request.prompts.length > AUTH_PROMPT_LIMITS.prompts) {
      return Promise.reject(new Error('too many keyboard-interactive prompts'));
    }
    return new Promise((resolve) => {
      const promptId = randomUUID();
      // Host-controlled text (§5.10): capped, without controls or invisible formatting.
      const message: ServerMessage = {
        type: 'auth.prompt',
        sessionId: this.sessionId,
        promptId,
        name: sanitizePromptText(request.name, AUTH_PROMPT_LIMITS.name, false),
        instructions: sanitizePromptText(
          request.instructions,
          AUTH_PROMPT_LIMITS.instructions,
          true,
        ),
        prompts: request.prompts.map((p) => ({
          text: sanitizePromptText(p.text, AUTH_PROMPT_LIMITS.text, false),
          echo: p.echo,
        })),
      };
      const timer = setTimeout(() => {
        if (this.#authPrompt?.id !== promptId) return;
        this.#authPrompt = null;
        this.#promptExpired = true;
        resolve(null);
      }, this.#promptTimeoutMs);
      this.#authPrompt = { id: promptId, message, timer, resolve };
      this.#setState('awaiting_user_input');
      this.#event('auth_prompt', { prompts: request.prompts.length });
      this.#notify(message);
    });
  }

  #cancelPrompt(): void {
    const prompt = this.#authPrompt;
    if (!prompt) return;
    clearTimeout(prompt.timer);
    this.#authPrompt = null;
    prompt.resolve(null);
  }

  /** Effective protection: chosen at first start, then honoured or degraded (§5.7, §5.11). */
  #chooseProtection(probe: ProbeResult): {
    protection: Protection;
    notice: string | null;
    degraded: boolean;
  } {
    const fixed = this.#protection;
    const wantsTmux = fixed === null || fixed === 'tmux-control';
    // An existing protected session keeps its protection even if the profile now says off.
    const mode = fixed === null ? this.#record.policies.protectionMode : 'auto';
    let { protection, notice } = wantsTmux
      ? selectProtection(mode, probe)
      : { protection: 'none' as Protection, notice: null as string | null };
    if (protection === 'tmux-control' && !this.#drivers.tmuxControl) {
      protection = 'none';
      notice = 'tmux control mode is not available: session not protected';
    }
    if (fixed === null) {
      this.#setProtection(protection);
      this.#event('protection_selected', { protection, ...(notice ? { notice } : {}) });
      return { protection, notice, degraded: false };
    }
    if (fixed !== 'none' && protection === 'none') {
      this.#setProtection('none');
      this.#event('protection_degraded', { from: fixed, ...(notice ? { notice } : {}) });
      return { protection: 'none', notice, degraded: true };
    }
    return {
      protection: fixed === 'tmux-control' ? 'tmux-control' : 'none',
      notice,
      degraded: false,
    };
  }

  #setProtection(protection: Protection): void {
    this.#protection = protection;
    this.#store.update(this.sessionId, { protection });
    this.#onSummaryChange();
  }

  #createDriver(protection: Protection, probe: ProbeResult, gen: number): Driver {
    const { policies } = this.#record;
    if (protection === 'tmux-control' && this.#drivers.tmuxControl) {
      return this.#drivers.tmuxControl({
        probe,
        socket: tmuxSocketName(this.#installationId, this.#record.tmuxToken),
        scrollbackLines: this.#record.scrollbackLines,
        startupCommand: policies.startupCommand,
        env: policies.env,
        previousIdentity: this.#record.remoteIdentity,
        onIdentity: (identity, rebooted) => {
          if (gen === this.#generation) this.#onIdentity(identity, rebooted);
        },
      });
    }
    return this.#drivers.rawPty({
      term: this.#record.term,
      env: policies.env,
      startupCommand: policies.startupCommand,
    });
  }

  #onIdentity(identity: RemoteIdentity, rebooted: boolean): void {
    this.#record.remoteIdentity = identity;
    this.#store.update(this.sessionId, { remoteIdentity: identity });
    if (!rebooted) return;
    // Out of band (ADR-0003 decisions): the emulator mirrors tmux's screen, so a banner written
    // into it would move the cursor away from tmux's and vanish at the next rebuild. The UI shows
    // the notice from the `ready` status detail; kept until a start succeeds.
    this.#event('remote_rebooted');
    this.#readyDetail = 'remote_rebooted';
  }

  #context(transport: Transport, gen: number, life: PromiseWithResolvers<LifeEnd>): DriverContext {
    const live = (): boolean => gen === this.#generation;
    return {
      transport,
      output: (chunk) => {
        if (live() && chunk.byteLength > 0) this.#output(chunk);
      },
      resized: (dims) => {
        if (live() && !sameSize(dims, this.#size)) this.#applyResize(dims, false);
      },
      replaceState: async (build) => {
        if (!live()) return;
        if (this.#state === 'starting') this.#setState('syncing');
        await this.#replaceEmulator(build, this.#protection !== 'tmux-control', gen);
      },
      banner: (text) => {
        if (live()) this.#banner(text);
      },
      onShellExit: () => {
        if (!live()) return;
        this.#exitedGen = gen;
        // A connection loss also closes the channel; give onLost the chance to win.
        setImmediate(() => life.resolve('exited'));
      },
      onDesync: (reason) => {
        if (!live()) return;
        this.#event('desync', { reason });
        life.resolve('lost');
      },
    };
  }

  #startSize(): Dimensions {
    if (this.#protection === 'tmux-control') return this.#policy.target() ?? this.#size;
    return this.#size;
  }

  #markReady(): void {
    const now = this.#now();
    const first = this.#record.lastReadyAt === null;
    this.#wasReady = true;
    this.#record.lastReadyAt = now;
    this.#store.update(this.sessionId, { lastReadyAt: now });
    const detail = this.#readyDetail;
    this.#readyDetail = null;
    this.#setState('ready', detail !== null ? { detail } : {});
    if (first) this.#onSummaryChange();
  }

  async #teardownAttempt(): Promise<void> {
    const transport = this.#transport;
    this.#driver = null;
    this.#transport = null;
    this.#setIngestPaused(false);
    if (transport) await closeQuietly(transport);
  }

  #stopActivity(): void {
    this.#generation++;
    this.#abort?.abort();
    this.#abort = null;
    this.#life?.resolve('stopped');
    this.#cancelPrompt();
    this.#wake?.();
    this.#driver = null;
    this.#transport = null;
    this.#setIngestPaused(false);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.#wake === done) this.#wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#wake = done;
    });
  }

  async #refreshPolicies(): Promise<void> {
    // Policies are read live from the profile (§9); the store resolves them.
    try {
      const fresh = await this.#store.get(this.sessionId);
      if (fresh) this.#record.policies = fresh.policies;
    } catch (err) {
      this.#warn('refresh policies', err);
    }
  }

  // ── state ───────────────────────────────────────────────────────────────────

  #setState(state: SessionState, extra: { detail?: string; retryInMs?: number } = {}): void {
    const from = this.#state;
    if (from === state && extra.detail === undefined && extra.retryInMs === undefined) return;
    this.#state = state;
    this.#statusDetail = extra.detail ?? null;
    const status = toSessionStatus(state, this.#wasReady);
    this.#store.update(this.sessionId, { state, status });
    this.#event('state_changed', {
      from,
      to: state,
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    });
    this.#notify({
      type: 'session.status',
      sessionId: this.sessionId,
      status,
      state,
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      ...(extra.retryInMs !== undefined ? { retryInMs: extra.retryInMs } : {}),
    });
  }

  #fail(code: string): void {
    this.#setState('failed', { detail: code });
  }

  #end(reason: EndReason): void {
    const now = this.#now();
    this.#desired = 'terminated';
    this.#record.endedAt = now;
    this.#record.endReason = reason;
    this.#pendingHostKey = null;
    this.#cancelPrompt();
    this.#store.update(this.sessionId, {
      desiredState: 'terminated',
      endedAt: now,
      endReason: reason,
    });
    this.#setState('ended', { detail: reason });
    this.#onSummaryChange();
    this.#maybeIdle();
  }

  #maybeIdle(): void {
    if (this.idle) this.#onIdle();
  }

  #event(type: string, detail?: Record<string, unknown>, actorUserId?: string): void {
    this.#store.appendEvent(this.sessionId, {
      type,
      ...(detail ? { detail } : {}),
      ...(actorUserId ? { actorUserId } : {}),
    });
  }

  /** `attached` / `detached` with the client's address and user agent (plan §10.2). */
  #clientEvent(type: string, attachmentId: string, client: AttachmentClient): void {
    this.#store.appendEvent(this.sessionId, {
      type,
      attachmentId,
      actorUserId: this.userId,
      ...(client.ip ? { ip: client.ip } : {}),
      ...(client.userAgent ? { userAgent: client.userAgent } : {}),
    });
  }

  #notify(message: ServerMessage): void {
    this.#notifier.sendToUser(this.userId, message);
  }

  #hostKeyPrompt(
    key: { type: string; fingerprint: string; revoked?: boolean },
    mismatch: boolean,
  ): ServerMessage {
    return {
      type: 'hostkey.prompt',
      sessionId: this.sessionId,
      keyType: key.type,
      fingerprint: key.fingerprint,
      mismatch,
      ...(mismatch && key.revoked ? { revoked: true } : {}),
    };
  }

  #warn(what: string, err: unknown): void {
    this.#log.warn({ err: describeError(err) }, what);
  }

  // ── output pipeline ─────────────────────────────────────────────────────────

  get #size(): Dimensions {
    return { cols: this.#emulator.cols, rows: this.#emulator.rows };
  }

  #createEmulator(dims: Dimensions, answerQueries: boolean): HeadlessEmulator {
    const emulator = new HeadlessEmulator({
      cols: dims.cols,
      rows: dims.rows,
      scrollback: this.#record.scrollbackLines,
      answerQueries,
    });
    emulator.onReply((data) => {
      // Query replies go to the remote only when nobody else answers (§5.3).
      if (this.#emulator === emulator && this.#protection !== 'tmux-control') {
        this.#driver?.input(data);
      }
    });
    emulator.onTitle((title) => {
      if (this.#emulator !== emulator) return;
      this.#toAttachments({ type: 'terminal.title', title: sanitizeTitle(title) });
    });
    emulator.onBell(() => {
      if (this.#emulator === emulator) this.#toAttachments({ type: 'terminal.bell' });
    });
    return emulator;
  }

  /** Assigns the seq, writes the emulator, fans out (§5.4). */
  #output(chunk: Uint8Array): void {
    const seq = ++this.#seq;
    this.#emulator.write(chunk);
    for (const attachment of this.#attachments.values()) attachment.output(seq, chunk);
    if (!this.#ingestPaused && this.#emulator.pendingBytes > INGEST_HIGH_WATER) {
      this.#setIngestPaused(true);
    }
  }

  #banner(text: string): void {
    this.#output(encoder.encode(`\r\n\x1b[0;2m── ${text} ──\x1b[0m\r\n`));
  }

  /** Pauses the driver's channel above 8 MiB of unparsed bytes; resumes below 1 MiB. */
  #setIngestPaused(paused: boolean): void {
    if (this.#ingestTimer) clearTimeout(this.#ingestTimer);
    this.#ingestTimer = null;
    if (paused !== this.#ingestPaused) {
      this.#ingestPaused = paused;
      if (paused) this.#driver?.pauseOutput();
      else this.#driver?.resumeOutput();
    }
    if (paused) this.#ingestTimer = setTimeout(() => this.#pollIngest(), this.#ingestPollMs);
  }

  #pollIngest(): void {
    this.#ingestTimer = null;
    if (!this.#ingestPaused) return;
    if (this.#emulator.pendingBytes < INGEST_LOW_WATER) this.#setIngestPaused(false);
    else this.#ingestTimer = setTimeout(() => this.#pollIngest(), this.#ingestPollMs);
  }

  #toAttachments(message: ChannelMessage): void {
    if (this.#attachments.size === 0) return;
    const frame = encodeChannelMessage(message);
    for (const attachment of this.#attachments.values()) attachment.message(frame.slice());
  }

  /** Snapshot barrier + gzip, cached per (seq, state generation) and shared by attachments. */
  #snapshot(): Promise<Snapshot> {
    const key = `${this.#seq}:${this.#stateGen}`;
    const cached = this.#snapshotCache;
    if (cached?.key === key) return cached.promise;
    const emulator = this.#emulator;
    // Recorded synchronously at the call: the barrier covers exactly these (ADR-0001).
    const seq = this.#seq;
    const { cols, rows } = emulator;
    const promise = emulator
      .snapshot()
      .then(async (raw) => ({ seq, cols, rows, gzipped: await gzipAsync(raw) }));
    const entry = { key, promise };
    this.#snapshotCache = entry;
    promise.catch(() => {
      if (this.#snapshotCache === entry) this.#snapshotCache = null;
    });
    return promise;
  }

  #resync(attachment: Attachment): void {
    const token = attachment.beginSync();
    this.#snapshot().then(
      (snap) => {
        if (this.#attachments.get(attachment.id) !== attachment) return;
        const frame = encodeSnapshotFrame(snap.seq, snap.cols, snap.rows, snap.gzipped);
        attachment.completeSync(token, frame, snap.seq);
      },
      (err) => this.#log.error({ err: describeError(err) }, 'snapshot failed'),
    );
  }

  async #replaceEmulator(
    build: (fresh: Emulator) => void | Promise<void>,
    answerQueries: boolean,
    gen?: number,
  ): Promise<void> {
    const fresh = this.#createEmulator(this.#size, answerQueries);
    try {
      await build(fresh);
    } catch (err) {
      fresh.dispose();
      throw err;
    }
    if (gen !== undefined && gen !== this.#generation) {
      fresh.dispose();
      return;
    }
    const old = this.#emulator;
    this.#emulator = fresh;
    this.#emulatorAnswers = answerQueries;
    this.#stateGen++;
    this.#snapshotCache = null;
    // Let a snapshot already queued on the old emulator settle before disposing it.
    void old.flush().then(() => old.dispose());
    for (const attachment of this.#attachments.values()) this.#resync(attachment);
  }

  /** Query answering is a property of the emulator; switch it when the protection changes. */
  async #ensureEmulatorMode(answerQueries: boolean): Promise<void> {
    if (this.#emulatorAnswers === answerQueries) return;
    const old = this.#emulator;
    await this.#replaceEmulator(async (fresh) => fresh.write(await old.snapshot()), answerQueries);
  }

  // ── size policy and sequenced resize (§5.5) ─────────────────────────────────

  #onPolicyChange(): void {
    const target = this.#policy.target();
    if (target && !sameSize(target, this.#size)) {
      if (this.#protection === 'tmux-control') {
        // tmux confirms the size with %layout-change → ctx.resized().
        if (this.#state === 'ready') this.#driver?.resize(target);
        return;
      }
      this.#applyResize(target, true);
      return;
    }
    if (this.#policy.active !== this.#lastActive) this.#broadcastResized(this.#seq);
  }

  /**
   * The resize is an event in the output stream: every attachment's pending output is flushed
   * (its last OUTPUT ends at seq N), the emulator resizes through its write queue, then every
   * attachment learns `terminal.resized { seq: N }` and applies it at the same position.
   */
  #applyResize(dims: Dimensions, resizeDriver: boolean): void {
    for (const attachment of this.#attachments.values()) attachment.flush();
    const seq = this.#seq;
    this.#emulator.resize(dims);
    this.#stateGen++;
    if (resizeDriver) this.#driver?.resize(dims);
    this.#store.update(this.sessionId, { cols: this.#emulator.cols, rows: this.#emulator.rows });
    this.#broadcastResized(seq);
  }

  #broadcastResized(seq: number): void {
    const active = this.#policy.active;
    this.#lastActive = active;
    const { cols, rows } = this.#size;
    for (const attachment of this.#attachments.values()) {
      attachment.message(
        encodeChannelMessage({
          type: 'terminal.resized',
          cols,
          rows,
          seq,
          activeAttachment: attachment.id === active,
        }),
      );
    }
  }
}

async function closeQuietly(transport: Transport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Already closed or never connected.
  }
}

function describeError(err: unknown): { name?: string; code?: string; message: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, ...(typeof code === 'string' ? { code } : {}), message: err.message };
  }
  return { message: String(err) };
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Titles go to the UI: no control characters, no invisible formatting (bidi overrides,
 * zero-width characters), at most 256 UTF-16 units (§7.3). The web's `cleanTitle` is the twin.
 */
export function sanitizeTitle(title: string): string {
  let out = '';
  for (const ch of title) {
    const code = ch.codePointAt(0)!;
    if (isControlChar(code) || isInvisibleFormatChar(code)) continue;
    if (out.length + ch.length > MAX_TITLE_LENGTH) break;
    out += ch;
  }
  return out;
}

/**
 * Keyboard-interactive text from the host (§5.10): C0/C1 controls and invisible formatting are
 * dropped (line feeds survive in `multiline` text such as instructions), then the text is cut
 * to `max` UTF-16 units without splitting a character.
 */
export function sanitizePromptText(text: string, max: number, multiline: boolean): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((isControlChar(code) && !(multiline && ch === '\n')) || isInvisibleFormatChar(code)) {
      continue;
    }
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}
