/**
 * Canonical runtime interfaces (plan §5.1). Names are binding; implementations live in
 * transport/, drivers/, emulator/ and core/.
 */
import type {
  EndReason,
  Protection,
  ProtectionMode,
  SessionState,
  SessionStatus,
  SessionSummary,
} from '@termdock/protocol';
import { ErrorCode } from '@termdock/shared';

export interface Dimensions {
  cols: number;
  rows: number;
}

export class TransportError extends Error {
  readonly retryable: boolean;
  readonly code: string;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * A launch parameter the remote command builders refuse to pass (plan §5.11 remote command rule):
 * a server setting with a line break or NUL, or a probe value (tmux path, locale) outside the
 * safe word set. Retrying cannot fix it, so the runtime fails the session with
 * BAD_LAUNCH_PARAMS instead of reconnecting. A RangeError, like the builders' other checks.
 */
export class BadLaunchParamsError extends RangeError {
  readonly code = ErrorCode.BadLaunchParams;

  constructor(message: string) {
    super(message);
    this.name = 'BadLaunchParamsError';
  }
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
}

export interface ExecChannel {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  write(data: Uint8Array): void;
  end(): void;
  /** Pauses/resumes reading stdout (backpressure). */
  pause(): void;
  resume(): void;
  /** Closes the channel on both sides (SSH channels; fakes may leave it out). */
  close?(): void;
  readonly exit: Promise<ExecResult>;
}

export interface PtyChannel extends ExecChannel {
  resize(dims: Dimensions): void;
}

export interface PtyOptions extends Dimensions {
  term: string;
  env?: Record<string, string>;
}

/** Byte pipe to a target. Knows nothing about terminals. */
export interface Transport {
  /** TCP + SSH handshake + host verification + auth (no-op for local). */
  connect(signal: AbortSignal): Promise<void>;
  /** Runs a command without a PTY: probes and `tmux -C`. */
  exec(command: string): Promise<ExecChannel>;
  /** Opens an interactive PTY shell (raw mode / tmux-normal). */
  openPty(opts: PtyOptions): Promise<PtyChannel>;
  close(): Promise<void>;
  /** The connection dropped after connect() succeeded. */
  onLost(cb: (err: TransportError) => void): void;
}

/**
 * Server-side authoritative terminal state for one session. Owned by the runtime; drivers
 * never write to it directly (they go through DriverContext).
 */
export interface Emulator {
  readonly cols: number;
  readonly rows: number;
  /**
   * Bytes handed to `write()` and not parsed yet (queued in xterm plus an incomplete trailing
   * UTF-8 character). The runtime uses it for ingest backpressure (plan §5.5).
   */
  readonly pendingBytes: number;
  write(data: Uint8Array): void;
  /** Applied through the write queue, so it lands at the right byte position. */
  resize(dims: Dimensions): void;
  /** Resolves once every previously written chunk has been parsed. */
  flush(): Promise<void>;
  /**
   * Snapshot payload (UTF-8 bytes): SerializeAddon output, then the mode epilogue (mouse
   * encoding, cursor style, tab stops, title, …) from the mode tracker, then the parser tail
   * (an escape sequence or character still incomplete at the barrier, so the client's parser
   * resumes in the same state when the following OUTPUT chunks arrive).
   *
   * This is the snapshot barrier (plan §5.4): it enqueues its own barrier and serializes
   * synchronously inside xterm's write callback, so the result reflects exactly the bytes and
   * resizes submitted before the call, even if more are written while the promise is pending.
   * `cols`/`rows` read at call time are the snapshot's size. Do not emulate it with
   * `await flush()` followed by a synchronous serialize: the promise continuation runs after
   * xterm has already parsed later chunks of the same write batch (ADR-0001).
   */
  snapshot(): Promise<Uint8Array>;
  /** Replies the emulator generates for terminal queries (raw / tmux-normal only). */
  onReply(cb: (data: Uint8Array) => void): void;
  onTitle(cb: (title: string) => void): void;
  onBell(cb: () => void): void;
  dispose(): void;
}

export interface DriverContext {
  transport: Transport;
  /** Driver output: the runtime assigns the seq, writes the emulator and fans out. */
  output(chunk: Uint8Array): void;
  /** The driver reports the effective terminal size (tmux-control: from %layout-change). */
  resized(dims: Dimensions): void;
  /**
   * Replaces the emulator wholesale (tmux-control rebuild after (re)attach or %pause): the
   * runtime creates a fresh emulator, the driver fills it, the runtime swaps it in and resyncs
   * every attachment.
   */
  replaceState(build: (fresh: Emulator) => void | Promise<void>): Promise<void>;
  /** Writes a dim informational banner line into the terminal (plan §5.7). */
  banner(text: string): void;
  onShellExit(info: { code: number | null }): void;
  /** Requests a full resync (tmux-control desync). */
  onDesync(reason: string): void;
}

/** Runs a terminal over a transport. */
export interface Driver {
  readonly protection: Protection;
  /** Attach-or-create; must leave the emulator in sync before resolving. */
  start(ctx: DriverContext, dims: Dimensions): Promise<void>;
  input(data: Uint8Array): void;
  resize(dims: Dimensions): void;
  /**
   * Ingest backpressure (plan §5.5): the runtime calls these when the emulator's pending writes
   * cross 8 MiB / fall below 1 MiB. Implementations pause/resume reading the underlying channel.
   */
  pauseOutput(): void;
  resumeOutput(): void;
  /** Leaves the remote alive (graceful shutdown). */
  detach(): Promise<void>;
  /** Kills the remote shell / tmux server. */
  terminate(): Promise<void>;
}

/** Decrypted credential material, held only in memory for the duration of a connect. */
export type CredentialSecret =
  | { kind: 'password'; password: string }
  | { kind: 'private_key'; privateKey: string; passphrase?: string };

/** Source of credential secrets: the vault in production, a dev file provider in P1 tests. */
export interface CredentialProvider {
  get(credentialId: string, userId: string): Promise<CredentialSecret>;
}

export interface AttachmentHandle {
  readonly id: string;
  /** Called with encoded frames/messages for this attachment's channel. */
  send(frame: Uint8Array): void;
  readonly bufferedAmount: number;
}

/** Who is behind an attachment, recorded with its `attached` / `detached` session events. */
export interface AttachmentClient {
  /** Client address: the socket peer, or `X-Forwarded-For` from a trusted proxy (plan §4.3). */
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Boundary of one session's runtime (state machine, emulator, driver, attachments). In-process
 * in the MVP; the post-MVP worker-per-session design (§18.1) moves it behind a socket.
 */
export interface SessionHost {
  readonly sessionId: string;
  start(): Promise<void>;
  /** `client` is given by the WebSocket server (events); internal hand-overs omit it. */
  attach(attachment: AttachmentHandle, viewport: Dimensions, client?: AttachmentClient): void;
  detach(attachmentId: string, client?: AttachmentClient): void;
  input(attachmentId: string, data: Uint8Array): void;
  activate(attachmentId: string): void;
  viewport(attachmentId: string, dims: Dimensions): void;
  resync(attachmentId: string): void;
  retry(): Promise<void>;
  terminate(): Promise<void>;
  /** Graceful shutdown: leave protected remotes alive. */
  shutdown(): Promise<void>;
}

// ── persistence boundaries (implemented over SQLite in P1; in-memory fakes in tests) ──────

/** Identity of the remote tmux session, recorded on first attach to detect remote reboots. */
export interface RemoteIdentity {
  sessionCreated: number;
  panePid: number;
}

/**
 * Target snapshotted from the server at session creation (plan §9, D-29): later server edits only
 * affect new sessions. `hostname` is normalized. A local session: 'localhost', port 0, no user.
 */
export interface SessionTarget {
  kind: 'ssh' | 'local';
  hostname: string;
  port: number;
  username: string;
  credentialId: string | null;
}

/** Live policies read from the session's server at use time (plan §9). */
export interface SessionPolicies {
  protectionMode: ProtectionMode;
  startupCommand: string | null;
  env: Record<string, string>;
  keepaliveIntervalS: number;
  autoReopen: boolean;
}

export interface SessionRecord {
  id: string;
  userId: string;
  /** The server the session was opened from; null once that server was deleted (history). */
  serverId: string | null;
  label: string;
  target: SessionTarget;
  term: string;
  scrollbackLines: number;
  policies: SessionPolicies;
  desiredState: 'running' | 'terminated';
  state: SessionState;
  status: SessionStatus;
  protection: Protection | null;
  /** Base of the per-session tmux socket name (plan §6.3). */
  tmuxToken: string;
  tmuxVersion: string | null;
  remoteIdentity: RemoteIdentity | null;
  cols: number;
  rows: number;
  createdAt: number;
  lastReadyAt: number | null;
  endedAt: number | null;
  endReason: EndReason | null;
}

export type SessionRecordPatch = Partial<
  Pick<
    SessionRecord,
    | 'desiredState'
    | 'state'
    | 'status'
    | 'protection'
    | 'tmuxVersion'
    | 'remoteIdentity'
    | 'cols'
    | 'rows'
    | 'lastReadyAt'
    | 'endedAt'
    | 'endReason'
  >
> & { probe?: Record<string, string> | null };

export interface SessionEventInput {
  type: string;
  detail?: Record<string, unknown>;
  actorUserId?: string;
  attachmentId?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Session persistence used by the runtime. Writes are fire-and-forget: the SQLite
 * implementation queues them in a batched writer so the data plane never waits on a lock.
 */
export interface SessionStore {
  get(sessionId: string): Promise<SessionRecord | null>;
  /** desired_state = running, excluding sessions whose last state is a non-retryable failure. */
  listRestorable(): Promise<SessionRecord[]>;
  /**
   * The user's sessions as listed to the UI (`sessions.list`), newest first. The store joins the
   * server's current name; the registry overlays the live runtime state on top.
   */
  listForUser(userId: string): Promise<SessionSummary[]>;
  update(sessionId: string, patch: SessionRecordPatch): void;
  appendEvent(sessionId: string, event: SessionEventInput): void;
  /**
   * Rejects with RATE_LIMITED (the create path's code and message) when the user already runs
   * the maximum number of sessions, not counting `sessionId`.
   */
  assertRunningCapacity(userId: string, sessionId: string): Promise<void>;
}

/** A host key as presented by the server (same shape as transport/ssh HostKeyInfo). */
export interface PresentedHostKey {
  type: string;
  fingerprint: string;
  publicKeyB64: string;
}

/**
 * What a host-key decision is keyed by (plan §5.9, D-29): one user's address, the normalized
 * hostname as typed (a DNS name or an IP) and the port, like OpenSSH's `known_hosts`. A decision
 * applies to every server of that user with that address and is never shared between users.
 * Stores normalize `hostname` themselves, so callers may pass it as stored or as typed.
 */
export interface HostKeyAddress {
  userId: string;
  hostname: string;
  port: number;
}

/**
 * An address plus the server that triggered a change there: the `host_key.*` audit row's target
 * (`targetType: 'server'`). The route's server, or the session's server at connect time; null
 * once that server is gone. It never scopes the decision itself.
 */
export interface HostKeyTarget extends HostKeyAddress {
  serverId: string | null;
}

/** The host-key target of a session: its owner, its snapshotted address and its server. */
export function sessionHostKeyTarget(record: SessionRecord): HostKeyTarget {
  return {
    userId: record.userId,
    hostname: record.target.hostname,
    port: record.target.port,
    serverId: record.serverId,
  };
}

/** Host-key trust store (plan §5.9). Only the daemon writes known_host_keys. */
export interface HostKeyStore {
  /** Trusted keys for an address, keyed by key type; loaded before connect. */
  trusted(address: HostKeyAddress): Promise<Map<string, PresentedHostKey>>;
  /**
   * Fingerprints the owner revoked for an address, loaded with the trusted keys: a server
   * presenting one fails closed like a mismatch (plan §5.9).
   */
  revoked(address: HostKeyAddress): Promise<Set<string>>;
  recordPending(target: HostKeyTarget, key: PresentedHostKey): Promise<void>;
  /**
   * Trusts the pending key with this fingerprint; false when none matches (expired) or the
   * fingerprint was revoked for the address.
   */
  trustPending(target: HostKeyTarget, fingerprint: string, decidedBy: string): Promise<boolean>;
  /**
   * A presented key matched a trusted row that has no `public_key_b64` (a pasted pre-trust
   * fingerprint): store the key itself on that row.
   */
  rememberPublicKey(address: HostKeyAddress, key: PresentedHostKey): Promise<void>;
}

/** Who owns what, for authorization checks on WS attach and internal API calls. */
export interface OwnershipCheck {
  sessionOwner(sessionId: string): Promise<string | null>;
}
