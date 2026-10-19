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

/** SFTP status codes (draft-ietf-secsh-filexfer-02 §7), as the server sends them. */
export const SftpStatus = {
  Ok: 0,
  Eof: 1,
  NoSuchFile: 2,
  PermissionDenied: 3,
  Failure: 4,
  BadMessage: 5,
  NoConnection: 6,
  ConnectionLost: 7,
  OpUnsupported: 8,
} as const;

/**
 * A failed SFTP request: the server's status and message (host text, untrusted), or
 * `ConnectionLost` when the channel closed under the request or before it.
 */
export class SftpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SftpError';
    this.status = status;
  }
}

/** File attributes as SFTP reports them; a field the server left out reads 0. */
export interface SftpAttrs {
  /** `st_mode`: file type and permission bits. */
  mode: number;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
}

/** A folder entry with its attributes (OpenSSH reports them as lstat sees the entry). */
export interface SftpDirEntry {
  name: string;
  attrs: SftpAttrs;
}

/** An open SFTP file or folder handle (opaque bytes). */
export type SftpHandle = Uint8Array;

/**
 * An SFTP channel on a session's connection (plan §5.12), with promise-returning requests. A
 * request fails with SftpError: the server's status, or `ConnectionLost` once the channel closed.
 */
export interface SftpSession {
  /** The server offers `posix-rename@openssh.com` (a rename that replaces atomically). */
  readonly supportsPosixRename: boolean;
  /** The channel closed: every request fails at once. */
  readonly closed: boolean;
  realpath(path: string): Promise<string>;
  /** Follows links. */
  stat(path: string): Promise<SftpAttrs>;
  /** The entry itself: a link is a link. */
  lstat(path: string): Promise<SftpAttrs>;
  readlink(path: string): Promise<string>;
  opendir(path: string): Promise<SftpHandle>;
  /** The next entries of an open folder (`.` and `..` may be among them), or null at its end. */
  readdir(handle: SftpHandle): Promise<SftpDirEntry[] | null>;
  close(handle: SftpHandle): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  /** Removes a file or a link (never what a link points to). */
  unlink(path: string): Promise<void>;
  /** SSH_FXP_RENAME: refuses an existing target on OpenSSH. */
  rename(from: string, to: string): Promise<void>;
  /** `posix-rename@openssh.com`; `OpUnsupported` when the server does not offer it. */
  posixRename(from: string, to: string): Promise<void>;
  /** Closes the channel; requests still pending fail with `ConnectionLost`. */
  end(): void;
  /** Called once when the channel closes (end(), the server, or the connection). */
  onClose(cb: () => void): void;
}

/** Byte pipe to a target. Knows nothing about terminals. */
export interface Transport {
  /** TCP + SSH handshake + host verification + auth (no-op for local). */
  connect(signal: AbortSignal): Promise<void>;
  /** Runs a command without a PTY: probes and `tmux -C`. */
  exec(command: string): Promise<ExecChannel>;
  /** Opens an interactive PTY shell (raw mode / tmux-normal). */
  openPty(opts: PtyOptions): Promise<PtyChannel>;
  /**
   * Opens an SFTP channel on the connection (plan §5.12). SESSION_NOT_CONNECTED when the
   * connection is not open, SFTP_UNAVAILABLE when the server refuses the `sftp` subsystem.
   * Absent: the transport has no file access (local sessions, D-15).
   */
  openSftp?(): Promise<SftpSession>;
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
  /**
   * The pane's foreground command as tmux names it (`#{pane_current_command}`), reported by
   * the tmux-control driver after a start and whenever tmux renames the window (plan D-33).
   */
  foreground?(command: string): void;
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
  /**
   * The folder the terminal is in, as the remote reports it (tmux-control:
   * `#{pane_current_path}`), or null when it cannot tell. The runtime validates it.
   */
  currentDirectory?(): Promise<string | null>;
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

/**
 * A session as the file panel sees it (plan §5.12), implemented by the runtime. Its SFTP channel
 * lives on the session's connection: opened on first use and reused while that connection lives.
 */
export interface FileHost {
  readonly sessionId: string;
  readonly userId: string;
  /** The session's server; null once that server was deleted. */
  readonly serverId: string | null;
  /**
   * The SFTP channel of the current connection, opened once and shared. SESSION_NOT_CONNECTED
   * unless the session is `ready`; dropped when the connection is torn down or lost.
   */
  sftp(): Promise<SftpSession>;
  /** Closes the channel (the file service, after a while without requests); reopened on use. */
  closeSftp(): void;
  /** The terminal's folder: an absolute single-line path, or null (not ready, or unknown). */
  currentDirectory(): Promise<string | null>;
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
  /**
   * The full socket name of a session adopted from a remote leftover (plan D-30); null for every
   * other session, whose socket is `td-<installation prefix>-<tmuxToken>`.
   */
  tmuxSocket: string | null;
  /** Absolute tmux path from the last stored probe (`probe_json` → `tmux_path`), if any. */
  tmuxPath: string | null;
  tmuxVersion: string | null;
  remoteIdentity: RemoteIdentity | null;
  cols: number;
  rows: number;
  createdAt: number;
  lastReadyAt: number | null;
  endedAt: number | null;
  endReason: EndReason | null;
  /**
   * The server's current target, as `SessionStore.get()` reads it (null once the server was
   * deleted; absent elsewhere). A session that never connected follows it (plan D-31).
   */
  serverTarget?: SessionTarget | null;
}

export type SessionRecordPatch = Partial<
  Pick<
    SessionRecord,
    | 'target'
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
   * Boot (plan §5.8): a session still `terminating` was being ended when the previous daemon
   * stopped (its remote tmux cleanup was cut short). It ends now (`user_terminated`), never
   * restored; a leftover tmux is ended by the next connection to its server (plan D-30).
   * Resolves with how many sessions it ended.
   */
  endInterruptedTerminations(): Promise<number>;
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
  /**
   * Deletes an ended session of `userId` with its `session_events` (plan D-32), audited as
   * `session.remove`: NOT_FOUND when it is not the user's, CONFLICT when it has not ended.
   * Committed before it resolves.
   */
  remove(userId: string, sessionId: string): Promise<void>;
  /** Deletes every ended session of `userId` the same way; resolves with their ids. */
  removeEnded(userId: string): Promise<string[]>;
}

/**
 * A session a remote tmux socket name belongs to (plan D-30): matched by its `tmux_socket`, or,
 * without one, by this installation's prefix plus its `tmux_token`. State and end time include
 * writes still queued in the batched writer.
 */
export interface SocketOwner {
  sessionId: string;
  userId: string;
  label: string;
  socket: string;
  state: SessionState;
  endedAt: number | null;
}

/** Session lookups of the remote leftover scan (plan D-30); SQLite in production. */
export interface RemoteSessionLookup {
  /** Every session (of any user) whose socket is one of `sockets`. */
  socketOwners(sockets: readonly string[], ownPrefix: string): Promise<SocketOwner[]>;
  /** The server's current name, or null when it is gone. */
  serverName(serverId: string): Promise<string | null>;
  appendEvent(sessionId: string, event: SessionEventInput): void;
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
