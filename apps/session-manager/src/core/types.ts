/**
 * Canonical runtime interfaces (plan §5.1). Names are binding; implementations live in
 * transport/, drivers/, emulator/ and core/.
 */
import type { Protection } from '@termdock/protocol';

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
  write(data: Uint8Array): void;
  /** Applied through the write queue, so it lands at the right byte position. */
  resize(dims: Dimensions): void;
  /** Resolves once every previously written chunk has been parsed (snapshot barrier). */
  flush(): Promise<void>;
  /**
   * Serialized state for a snapshot: SerializeAddon output followed by the mode epilogue
   * (mouse encoding, cursor style, tab stops, title) from the mode tracker. Call after flush().
   */
  snapshot(): string;
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

/**
 * Boundary of one session's runtime (state machine, emulator, driver, attachments). In-process
 * in the MVP; the post-MVP worker-per-session design (§18.1) moves it behind a socket.
 */
export interface SessionHost {
  readonly sessionId: string;
  start(): Promise<void>;
  attach(attachment: AttachmentHandle, viewport: Dimensions): void;
  detach(attachmentId: string): void;
  input(attachmentId: string, data: Uint8Array): void;
  activate(attachmentId: string): void;
  viewport(attachmentId: string, dims: Dimensions): void;
  resync(attachmentId: string): void;
  retry(): Promise<void>;
  terminate(): Promise<void>;
  /** Graceful shutdown: leave protected remotes alive. */
  shutdown(): Promise<void>;
}
