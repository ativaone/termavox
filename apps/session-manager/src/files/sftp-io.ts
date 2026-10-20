import { Readable, Writable } from 'node:stream';
import { ErrorCode, TermdockError } from '@termdock/shared';
import type { SftpHandle, SftpSession } from '../core/types.ts';

/**
 * Pipelined SFTP file I/O for the transfers (plan §5.12 "Throughput"). ssh2's own streams keep one
 * request in flight, which caps a transfer at one request per round trip; these keep a bounded
 * window of requests instead. The window is small on purpose: a transfer shares the TCP connection
 * with the session's keystrokes.
 */

/** Bytes per SFTP read or write request. */
export const IO_CHUNK_BYTES = 32 * 1024;
/**
 * Requests one transfer keeps in flight at most; a download counts the answers it holds for an
 * earlier chunk among them.
 */
export const IO_MAX_IN_FLIGHT = 16;

export interface SftpIoOptions {
  chunkBytes?: number;
  maxInFlight?: number;
}

/** Resolves once no request of a stream is running any more. */
class InFlight {
  count = 0;
  #idle: PromiseWithResolvers<void> | null = null;

  start(): void {
    this.count++;
  }

  end(): void {
    this.count--;
    if (this.count === 0 && this.#idle) {
      this.#idle.resolve();
      this.#idle = null;
    }
  }

  settled(): Promise<void> {
    if (this.count === 0) return Promise.resolve();
    this.#idle ??= Promise.withResolvers<void>();
    return this.#idle.promise;
  }
}

/**
 * Exactly `size` bytes of an open file, from offset 0: `chunkBytes` requests, delivered in file
 * order whatever order the answers come in. At most `maxInFlight` chunks are ever ahead of what
 * was delivered, requests in flight and answers waiting for an earlier chunk together: a server
 * that holds back one answer cannot make the reader ask for (and hold) the rest of the file. No
 * new request starts while the consumer is behind (backpressure). A file that turns out shorter
 * than `size` (it shrank since its size was read) fails the stream: the response is cut, never
 * padded. The handle stays the caller's: close it after `settled()`.
 */
export class SftpFileReader extends Readable {
  readonly #sftp: SftpSession;
  readonly #handle: SftpHandle;
  readonly #size: number;
  readonly #chunk: number;
  readonly #window: number;
  readonly #requests = new InFlight();
  /** Answers waiting for an earlier chunk, by offset: they count against the window. */
  readonly #ready = new Map<number, Uint8Array>();
  #requested = 0;
  #delivered = 0;
  #wanted = false;
  #ended = false;

  constructor(sftp: SftpSession, handle: SftpHandle, size: number, options: SftpIoOptions = {}) {
    const chunk = options.chunkBytes ?? IO_CHUNK_BYTES;
    super({ highWaterMark: chunk });
    this.#sftp = sftp;
    this.#handle = handle;
    this.#size = size;
    this.#chunk = chunk;
    this.#window = options.maxInFlight ?? IO_MAX_IN_FLIGHT;
  }

  /** Resolves once no read request is running (then the handle may be closed). */
  settled(): Promise<void> {
    return this.#requests.settled();
  }

  override _read(): void {
    this.#wanted = true;
    this.#deliver();
    this.#request();
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.#ready.clear();
    cb(err);
  }

  #request(): void {
    while (
      this.#wanted &&
      !this.destroyed &&
      this.#requests.count + this.#ready.size < this.#window &&
      this.#requested < this.#size
    ) {
      const offset = this.#requested;
      const length = Math.min(this.#chunk, this.#size - offset);
      this.#requested += length;
      this.#requests.start();
      this.#readFully(offset, length).then(
        (data) => {
          this.#requests.end();
          if (this.destroyed) return;
          this.#ready.set(offset, data);
          this.#deliver();
          this.#request();
        },
        (err: unknown) => {
          this.#requests.end();
          if (!this.destroyed) this.destroy(err as Error);
        },
      );
    }
  }

  /** Pushes the answers that continue the file, in order. */
  #deliver(): void {
    for (
      let data = this.#ready.get(this.#delivered);
      data;
      data = this.#ready.get(this.#delivered)
    ) {
      this.#ready.delete(this.#delivered);
      this.#delivered += data.length;
      if (!this.push(data)) this.#wanted = false;
    }
    if (!this.#ended && this.#delivered >= this.#size) {
      this.#ended = true;
      this.push(null);
    }
  }

  /** One chunk: a server answering short is asked again for the rest. */
  async #readFully(offset: number, length: number): Promise<Uint8Array> {
    let data = await this.#sftp.read(this.#handle, length, offset);
    if (data.length === length) return data;
    const whole = new Uint8Array(length);
    let filled = 0;
    while (data.length > 0) {
      whole.set(data, filled);
      filled += data.length;
      if (filled === length) return whole;
      data = await this.#sftp.read(this.#handle, length - filled, offset + filled);
    }
    throw new TermdockError(ErrorCode.FileOpFailed, 'the file is shorter than its size');
  }
}

export interface SftpFileWriterOptions extends SftpIoOptions {
  /** Bytes the server confirmed so far, after each write it confirmed. */
  onWritten?: (bytes: number) => void;
}

/**
 * Writes a stream into an open file from offset 0: the data is cut into `chunkBytes` writes at
 * explicit offsets, at most `maxInFlight` at once; the stream is held (backpressure) while the
 * window is full. The first failed write fails the stream; finishing waits for every write. The
 * handle stays the caller's: close it after `settled()`.
 */
export class SftpFileWriter extends Writable {
  readonly #sftp: SftpSession;
  readonly #handle: SftpHandle;
  readonly #chunk: number;
  readonly #window: number;
  readonly #onWritten: ((bytes: number) => void) | undefined;
  readonly #requests = new InFlight();
  /** Received and not sent yet: less than one chunk between writes. */
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #offset = 0;
  #written = 0;
  #failure: Error | null = null;
  #slotFree: (() => void) | null = null;

  constructor(sftp: SftpSession, handle: SftpHandle, options: SftpFileWriterOptions = {}) {
    const chunk = options.chunkBytes ?? IO_CHUNK_BYTES;
    super({ highWaterMark: chunk });
    this.#sftp = sftp;
    this.#handle = handle;
    this.#chunk = chunk;
    this.#window = options.maxInFlight ?? IO_MAX_IN_FLIGHT;
    this.#onWritten = options.onWritten;
  }

  /** Bytes the server confirmed. */
  get written(): number {
    return this.#written;
  }

  /** Resolves once no write request is running (then the handle may be closed). */
  settled(): Promise<void> {
    return this.#requests.settled();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.#pending.push(chunk);
    this.#pendingBytes += chunk.length;
    this.#send(false).then(() => cb(), cb);
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.#send(true)
      .then(() => this.#requests.settled())
      .then(() => cb(this.#failure), cb);
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#wake();
    cb(err);
  }

  /** Sends every whole chunk received (and the rest too when `all`), holding while the window is full. */
  async #send(all: boolean): Promise<void> {
    while (this.#pendingBytes >= this.#chunk || (all && this.#pendingBytes > 0)) {
      while (this.#requests.count >= this.#window && !this.#failure && !this.destroyed) {
        await new Promise<void>((resolve) => {
          this.#slotFree = resolve;
        });
      }
      if (this.#failure) throw this.#failure;
      if (this.destroyed) throw new Error('the upload stopped');
      this.#issue(this.#take(Math.min(this.#chunk, this.#pendingBytes)));
    }
    if (this.#failure) throw this.#failure;
  }

  #issue(data: Buffer): void {
    const position = this.#offset;
    this.#offset += data.length;
    this.#requests.start();
    this.#sftp.write(this.#handle, data, position).then(
      () => {
        this.#written += data.length;
        this.#requests.end();
        this.#wake();
        if (!this.#failure) this.#onWritten?.(this.#written);
      },
      (err: unknown) => {
        this.#failure ??= err as Error;
        this.#requests.end();
        this.#wake();
        // Nothing may be waiting on this stream (the body is between chunks): fail it now.
        if (!this.destroyed) this.destroy(this.#failure);
      },
    );
  }

  #take(bytes: number): Buffer {
    const parts: Buffer[] = [];
    let taken = 0;
    while (taken < bytes) {
      const head = this.#pending[0]!;
      const need = bytes - taken;
      if (head.length <= need) {
        parts.push(head);
        this.#pending.shift();
        taken += head.length;
      } else {
        parts.push(head.subarray(0, need));
        this.#pending[0] = head.subarray(need);
        taken += need;
      }
    }
    this.#pendingBytes -= bytes;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, bytes);
  }

  #wake(): void {
    const wake = this.#slotFree;
    this.#slotFree = null;
    wake?.();
  }
}
