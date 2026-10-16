/** In-memory fakes for the runtime boundaries (stores, transport, attachments). */
import type { ServerMessage, SessionState, SessionSummary } from '@termdock/protocol';
import { bindToChannel } from '../../src/attachments/wire.ts';
import {
  createDriverFactory,
  type DriverFactory,
  type TmuxControlDriverOptions,
} from '../../src/core/driver-factory.ts';
import { SessionRuntime, type SessionRuntimeOptions } from '../../src/core/session-runtime.ts';
import type { TransportFactory, TransportHooks } from '../../src/core/transport-factory.ts';
import {
  type AttachmentHandle,
  type Dimensions,
  type DriverContext,
  type ExecResult,
  type HostKeyStore,
  type PresentedHostKey,
  type PtyChannel,
  type PtyOptions,
  type SessionEventInput,
  type SessionRecord,
  type SessionRecordPatch,
  type SessionStore,
  type Transport,
  TransportError,
} from '../../src/core/types.ts';
import { ChunkQueue } from '../../src/transport/chunk-queue.ts';
import { ClientTerminal } from '../ws/client.ts';

export const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

export const TEST_KEY: PresentedHostKey = {
  type: 'ssh-ed25519',
  fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  publicKeyB64: 'AAAAC3NzaC1lZDI1NTE5AAAAIA==',
};

export function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    userId: 'user-1',
    label: 'test',
    target: {
      kind: 'ssh',
      hostId: 'host-1',
      hostname: '127.0.0.1',
      port: 22,
      username: 'td',
      credentialId: null,
    },
    term: 'xterm-256color',
    scrollbackLines: 1000,
    policies: {
      protectionMode: 'auto',
      startupCommand: null,
      env: {},
      keepaliveIntervalS: 15,
      autoReopen: true,
    },
    desiredState: 'running',
    state: 'new',
    status: 'connecting',
    protection: null,
    tmuxToken: 'abcdefghijkl',
    tmuxVersion: null,
    remoteIdentity: null,
    cols: 80,
    rows: 24,
    createdAt: 0,
    lastReadyAt: null,
    endedAt: null,
    endReason: null,
    ...overrides,
  };
}

export class MemorySessionStore implements SessionStore {
  readonly records = new Map<string, SessionRecord>();
  readonly updates: Array<{ sessionId: string; patch: SessionRecordPatch }> = [];
  readonly events: Array<SessionEventInput & { sessionId: string }> = [];

  add(record: SessionRecord): SessionRecord {
    this.records.set(record.id, structuredClone(record));
    return record;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const record = this.records.get(sessionId);
    return record ? structuredClone(record) : null;
  }

  async listRestorable(): Promise<SessionRecord[]> {
    return [...this.records.values()].filter(
      (r) => r.desiredState === 'running' && r.state !== 'failed',
    );
  }

  async listForUser(userId: string): Promise<SessionSummary[]> {
    return [...this.records.values()]
      .filter((r) => r.userId === userId)
      .map((r) => ({
        id: r.id,
        label: r.label,
        profileId: 'profile-1',
        hostId: r.target.hostId,
        hostName: 'test host',
        hostname: r.target.hostname,
        username: r.target.username,
        state: r.state,
        status: r.status,
        protection: r.protection,
        createdAt: r.createdAt,
        lastReadyAt: r.lastReadyAt,
        endedAt: r.endedAt,
        endReason: r.endReason,
      }));
  }

  update(sessionId: string, patch: SessionRecordPatch): void {
    this.updates.push({ sessionId, patch });
    const record = this.records.get(sessionId);
    if (!record) return;
    const { probe: _probe, ...fields } = patch;
    Object.assign(record, fields);
  }

  appendEvent(sessionId: string, event: SessionEventInput): void {
    this.events.push({ sessionId, ...event });
  }

  /** Persisted state/status pairs, in order. */
  transitions(sessionId: string): Array<[SessionState, string]> {
    return this.updates
      .filter((u) => u.sessionId === sessionId && u.patch.state !== undefined)
      .map((u) => [u.patch.state!, u.patch.status!]);
  }
}

export class MemoryHostKeyStore implements HostKeyStore {
  readonly trustedKeys = new Map<string, Map<string, PresentedHostKey>>();
  readonly pending: Array<{ hostId: string; key: PresentedHostKey }> = [];

  trust(hostId: string, key: PresentedHostKey): void {
    const keys = this.trustedKeys.get(hostId) ?? new Map<string, PresentedHostKey>();
    keys.set(key.type, key);
    this.trustedKeys.set(hostId, keys);
  }

  async trusted(hostId: string): Promise<Map<string, PresentedHostKey>> {
    return new Map(this.trustedKeys.get(hostId) ?? []);
  }

  async recordPending(hostId: string, key: PresentedHostKey): Promise<void> {
    this.pending.push({ hostId, key });
  }

  async trustPending(hostId: string, fingerprint: string): Promise<boolean> {
    const index = this.pending.findIndex(
      (p) => p.hostId === hostId && p.key.fingerprint === fingerprint,
    );
    if (index < 0) return false;
    const [entry] = this.pending.splice(index, 1);
    this.trust(hostId, entry!.key);
    return true;
  }

  async rememberPublicKey(hostId: string, key: PresentedHostKey): Promise<void> {
    const trusted = this.trustedKeys.get(hostId)?.get(key.type);
    if (trusted?.fingerprint === key.fingerprint && !trusted.publicKeyB64) {
      trusted.publicKeyB64 = key.publicKeyB64;
    }
  }
}

export class FakePtyChannel implements PtyChannel {
  readonly stdout = new ChunkQueue();
  readonly stderr = new ChunkQueue();
  readonly exit: Promise<ExecResult>;
  readonly written: Uint8Array[] = [];
  readonly resizes: Dimensions[] = [];
  readonly options: PtyOptions | null;
  paused = false;
  ended = false;
  #resolveExit!: (result: ExecResult) => void;

  constructor(options: PtyOptions | null = null) {
    this.options = options;
    this.exit = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  write(data: Uint8Array): void {
    this.written.push(data);
  }

  end(): void {
    this.ended = true;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  resize(dims: Dimensions): void {
    this.resizes.push(dims);
  }

  /** The remote side closes the channel. */
  finish(result: ExecResult): void {
    this.stdout.end();
    this.stderr.end();
    this.#resolveExit(result);
  }

  get writtenText(): string {
    return Buffer.concat(this.written).toString('utf8');
  }
}

export interface FakeTransportBehavior {
  /** Runs inside connect(); throw to fail the attempt. Default: a trusted host key. */
  connect?: (hooks: TransportHooks, signal: AbortSignal) => Promise<void>;
  probe?: string;
}

export class FakeTransport implements Transport {
  readonly ptys: FakePtyChannel[] = [];
  readonly #lost: Array<(err: TransportError) => void> = [];
  readonly #behavior: FakeTransportBehavior;
  readonly #hooks: TransportHooks;
  connected = false;
  closed = false;

  constructor(hooks: TransportHooks, behavior: FakeTransportBehavior = {}) {
    this.#hooks = hooks;
    this.#behavior = behavior;
  }

  async connect(signal: AbortSignal): Promise<void> {
    if (this.#behavior.connect) await this.#behavior.connect(this.#hooks, signal);
    else this.#hooks.onHostKey({ ...TEST_KEY }, 'trusted');
    this.connected = true;
  }

  async exec(): Promise<FakePtyChannel> {
    const channel = new FakePtyChannel();
    channel.stdout.push(encode(this.#behavior.probe ?? 'shell=/bin/bash\nutf8_locale=C.UTF-8\n'));
    channel.finish({ code: 0, signal: null });
    return channel;
  }

  async openPty(options: PtyOptions): Promise<FakePtyChannel> {
    const channel = new FakePtyChannel(options);
    this.ptys.push(channel);
    return channel;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  onLost(cb: (err: TransportError) => void): void {
    this.#lost.push(cb);
  }

  /** Same order as ssh2: onLost first, then the channels close without an exit status. */
  lose(): void {
    for (const cb of this.#lost) cb(new TransportError('CONNECTION_LOST', 'lost', true));
    for (const pty of this.ptys) pty.finish({ code: null, signal: null });
  }

  get pty(): FakePtyChannel {
    const pty = this.ptys.at(-1);
    if (!pty) throw new Error('no PTY opened');
    return pty;
  }
}

export class FakeTransportFactory implements TransportFactory {
  readonly created: FakeTransport[] = [];
  readonly times: number[] = [];
  readonly #behavior: (attempt: number) => FakeTransportBehavior;

  constructor(behavior: (attempt: number) => FakeTransportBehavior = () => ({})) {
    this.#behavior = behavior;
  }

  async create(_record: SessionRecord, hooks: TransportHooks): Promise<FakeTransport> {
    const transport = new FakeTransport(hooks, this.#behavior(this.created.length));
    this.created.push(transport);
    this.times.push(Date.now());
    return transport;
  }

  get last(): FakeTransport {
    const transport = this.created.at(-1);
    if (!transport) throw new Error('no transport created');
    return transport;
  }
}

export class RecordingNotifier {
  readonly messages: Array<{ userId: string; message: ServerMessage }> = [];

  sendToUser(userId: string, message: ServerMessage): void {
    this.messages.push({ userId, message });
  }

  ofType<K extends ServerMessage['type']>(type: K): Array<Extract<ServerMessage, { type: K }>> {
    return this.messages
      .map((m) => m.message)
      .filter((m): m is Extract<ServerMessage, { type: K }> => m.type === type);
  }
}

/** An attachment whose frames feed a client-side terminal. */
export class FakeAttachment implements AttachmentHandle {
  readonly id: string;
  readonly client = new ClientTerminal();
  readonly frames: Uint8Array[] = [];
  bufferedAmount = 0;

  constructor(id: string) {
    this.id = id;
  }

  send(frame: Uint8Array): void {
    this.frames.push(frame.slice());
    this.client.push(bindToChannel(frame, 7));
  }
}

export interface Harness {
  store: MemorySessionStore;
  hostKeys: MemoryHostKeyStore;
  notifier: RecordingNotifier;
  factory: FakeTransportFactory;
  drivers: DriverFactory;
  runtime(overrides?: Partial<SessionRuntimeOptions>): SessionRuntime;
}

export function harness(
  options: {
    record?: Partial<SessionRecord>;
    behavior?: (attempt: number) => FakeTransportBehavior;
    drivers?: DriverFactory;
  } = {},
): Harness {
  const store = new MemorySessionStore();
  const hostKeys = new MemoryHostKeyStore();
  const notifier = new RecordingNotifier();
  const factory = new FakeTransportFactory(options.behavior);
  const drivers = options.drivers ?? createDriverFactory();
  const record = store.add(makeRecord(options.record));
  return {
    store,
    hostKeys,
    notifier,
    factory,
    drivers,
    runtime: (overrides = {}) =>
      new SessionRuntime({
        record,
        store,
        hostKeys,
        transports: factory,
        drivers,
        notifier,
        installationId: 'install-1',
        resizeDebounceMs: 1,
        lagPollMs: 5,
        ...overrides,
      }),
  };
}

/** Probe output of a host where tmux-control is selected. */
export const TMUX_PROBE =
  'shell=/bin/bash\ntmux_path=/usr/bin/tmux\ntmux_version=tmux 3.4\nutf8_locale=C.UTF-8\n';

/** A driver factory whose tmux-control driver runs `start` (raw mode stays the real driver). */
export function fakeTmuxDrivers(
  start: (ctx: DriverContext, opts: TmuxControlDriverOptions) => Promise<void>,
): DriverFactory {
  return createDriverFactory((opts) => ({
    protection: 'tmux-control',
    start: (ctx) => start(ctx, opts),
    input() {},
    resize() {},
    pauseOutput() {},
    resumeOutput() {},
    detach: async () => {},
    terminate: async () => {},
  }));
}

/** Polls until `predicate` holds (real timers). */
export async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
