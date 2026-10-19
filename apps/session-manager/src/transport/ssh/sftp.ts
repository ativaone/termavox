import { ErrorCode, TermdockError } from '@termdock/shared';
import type { Attributes, FileEntryWithStats, SFTPWrapper } from 'ssh2';
import {
  type SftpAttrs,
  type SftpDirEntry,
  SftpError,
  type SftpHandle,
  type SftpSession,
  SftpStatus,
} from '../../core/types.ts';
import { hostText } from '../../drivers/tmux-control/host-text.ts';

/** A server that accepts the channel but never starts SFTP must not hold the panel forever. */
export const SFTP_OPEN_TIMEOUT_MS = 20_000;
/** Server text quoted in an open error. */
const OPEN_ERROR_TEXT_MAX = 200;
const POSIX_RENAME = 'posix-rename@openssh.com';

/** The part of ssh2's Client this module uses (tests pass a fake). */
export interface SftpClient {
  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): unknown;
}

export interface OpenSftpOptions {
  /** The SSH connection is still up: an open failing after it dropped is not the server's refusal. */
  connected: () => boolean;
  timeoutMs?: number;
}

/**
 * Opens the `sftp` subsystem on an ssh2 connection (plan §5.12). A server that refuses it, or whose
 * sftp-server exits at once, is SFTP_UNAVAILABLE; a connection that is gone, SESSION_NOT_CONNECTED;
 * a server that refuses another channel (OpenSSH `MaxSessions`), FILE_OP_FAILED.
 */
export function openSshSftp(client: SftpClient, options: OpenSftpOptions): Promise<SftpSession> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new TermdockError(ErrorCode.SftpUnavailable, 'the server did not start SFTP in time'));
    }, options.timeoutMs ?? SFTP_OPEN_TIMEOUT_MS);
    const done = (err: Error | undefined, wrapper?: SFTPWrapper): void => {
      if (settled) {
        // Timed out meanwhile: nobody will use this channel.
        if (!err) wrapper?.end();
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err || !wrapper) reject(openError(err, options.connected()));
      else resolve(new SshSftpSession(wrapper));
    };
    try {
      client.sftp(done);
    } catch {
      // ssh2 throws 'Not connected' synchronously when its socket is gone.
      done(new TermdockError(ErrorCode.SessionNotConnected, 'the session is not connected'));
    }
  });
}

function openError(err: Error | undefined, connected: boolean): TermdockError {
  if (err instanceof TermdockError) return err;
  if (!connected) {
    return new TermdockError(ErrorCode.SessionNotConnected, 'the session is not connected');
  }
  const message = hostText(err?.message ?? 'unknown error', OPEN_ERROR_TEXT_MAX);
  // ssh2 sets `reason` (a number) when the server refused to open the channel itself.
  if (typeof (err as { reason?: unknown } | undefined)?.reason === 'number') {
    return new TermdockError(ErrorCode.FileOpFailed, `the server refused a channel: ${message}`);
  }
  // "Unable to start subsystem: sftp", "Received exit code N while establishing SFTP session", or
  // an SFTP protocol error during the version exchange (a shell printing into the channel).
  return new TermdockError(ErrorCode.SftpUnavailable, `the server offers no SFTP: ${message}`);
}

type Callback<T> = (err: Error | null | undefined, value?: T) => void;

/** ssh2's SFTPWrapper behind the promise-based SftpSession. */
export class SshSftpSession implements SftpSession {
  readonly supportsPosixRename: boolean;
  readonly #wrapper: SFTPWrapper;
  readonly #closeCallbacks: Array<() => void> = [];
  #closed = false;

  constructor(wrapper: SFTPWrapper) {
    this.#wrapper = wrapper;
    const extensions = (wrapper as unknown as { _extensions?: Record<string, string> })._extensions;
    this.supportsPosixRename = extensions?.[POSIX_RENAME] === '1';
    // ssh2 removed its own listeners once the session was ready: an unhandled 'error' (a fatal
    // protocol error) would crash the process. Requests pending then fail through 'end'.
    wrapper.on('error', () => this.#markClosed());
    wrapper.on('end', () => this.#markClosed());
    wrapper.on('close', () => this.#markClosed());
  }

  get closed(): boolean {
    return this.#closed || !this.#channelOpen();
  }

  realpath(path: string): Promise<string> {
    return this.#call<string>((cb) => this.#wrapper.realpath(path, cb));
  }

  async stat(path: string): Promise<SftpAttrs> {
    return toAttrs(await this.#call<Attributes>((cb) => this.#wrapper.stat(path, cb)));
  }

  async lstat(path: string): Promise<SftpAttrs> {
    return toAttrs(await this.#call<Attributes>((cb) => this.#wrapper.lstat(path, cb)));
  }

  readlink(path: string): Promise<string> {
    return this.#call<string>((cb) => this.#wrapper.readlink(path, cb));
  }

  opendir(path: string): Promise<SftpHandle> {
    return this.#call<Buffer>((cb) => this.#wrapper.opendir(path, cb));
  }

  async readdir(handle: SftpHandle): Promise<SftpDirEntry[] | null> {
    try {
      const list = await this.#call<FileEntryWithStats[]>((cb) =>
        this.#wrapper.readdir(Buffer.from(handle.buffer, handle.byteOffset, handle.byteLength), cb),
      );
      return list.map((entry) => ({ name: entry.filename, attrs: toAttrs(entry.attrs) }));
    } catch (err) {
      if (err instanceof SftpError && err.status === SftpStatus.Eof) return null;
      throw err;
    }
  }

  close(handle: SftpHandle): Promise<void> {
    const buffer = Buffer.from(handle.buffer, handle.byteOffset, handle.byteLength);
    return this.#call<void>((cb) => this.#wrapper.close(buffer, cb));
  }

  mkdir(path: string): Promise<void> {
    return this.#call<void>((cb) => this.#wrapper.mkdir(path, cb));
  }

  rmdir(path: string): Promise<void> {
    return this.#call<void>((cb) => this.#wrapper.rmdir(path, cb));
  }

  unlink(path: string): Promise<void> {
    return this.#call<void>((cb) => this.#wrapper.unlink(path, cb));
  }

  rename(from: string, to: string): Promise<void> {
    return this.#call<void>((cb) => this.#wrapper.rename(from, to, cb));
  }

  posixRename(from: string, to: string): Promise<void> {
    if (!this.supportsPosixRename) {
      return Promise.reject(
        new SftpError(SftpStatus.OpUnsupported, `the server does not offer ${POSIX_RENAME}`),
      );
    }
    return this.#call<void>((cb) => this.#wrapper.ext_openssh_rename(from, to, cb));
  }

  end(): void {
    if (this.#closed) return;
    this.#wrapper.end();
    this.#markClosed();
  }

  onClose(cb: () => void): void {
    if (this.#closed) queueMicrotask(cb);
    else this.#closeCallbacks.push(cb);
  }

  /**
   * One request. ssh2 neither sends nor answers a request made once the channel is closing: it
   * would wait forever, so it fails at once instead.
   */
  #call<T>(request: (cb: Callback<T>) => void): Promise<T> {
    if (this.closed) return Promise.reject(channelClosed());
    return new Promise<T>((resolve, reject) => {
      const cb: Callback<T> = (err, value) => {
        if (err) reject(this.#error(err));
        else resolve(value as T);
      };
      try {
        request(cb);
      } catch (err) {
        reject(this.#error(err as Error));
      }
    });
  }

  /** The server's status is kept; a request cut by the channel's close is `ConnectionLost`. */
  #error(err: Error): Error {
    const status = (err as { code?: unknown }).code;
    if (typeof status === 'number') return new SftpError(status, err.message);
    // ssh2 fails requests pending at the close with 'No response from server' (no status).
    if (this.closed) return channelClosed();
    return err;
  }

  /** ssh2 marks the channel's halves closed before it fails the pending requests. */
  #channelOpen(): boolean {
    const channel = this.#wrapper as unknown as {
      incoming?: { state?: string };
      outgoing?: { state?: string };
    };
    return channel.incoming?.state !== 'closed' && (channel.outgoing?.state ?? 'open') === 'open';
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const cb of this.#closeCallbacks.splice(0)) cb();
  }
}

function channelClosed(): SftpError {
  return new SftpError(SftpStatus.ConnectionLost, 'the SFTP channel is closed');
}

function toAttrs(attrs: Partial<Attributes> | undefined): SftpAttrs {
  return {
    mode: numberOr0(attrs?.mode),
    size: numberOr0(attrs?.size),
    mtime: numberOr0(attrs?.mtime),
  };
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
