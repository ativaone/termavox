import type { ClientChannel } from 'ssh2';
import type { Dimensions, ExecChannel, ExecResult, PtyChannel } from '../../core/types.ts';
import { ChunkQueue } from '../chunk-queue.ts';

/** Local stdout buffering before the SSH window stops being replenished. */
const STDOUT_HIGH_WATER = 4 * 1024 * 1024;
const STDOUT_LOW_WATER = 1024 * 1024;
/** stderr is always drained (it shares the channel window); keep only the newest bytes. */
const STDERR_MAX_BYTES = 1024 * 1024;

/**
 * Adapts an ssh2 session channel to ExecChannel. stdout is paused at its source either
 * explicitly (`pause()`, runtime ingest backpressure) or when the local queue passes its high
 * water mark; ssh2 then stops adjusting the SSH window and the remote blocks.
 */
export class SshExecChannel implements ExecChannel {
  readonly stdout: ChunkQueue;
  readonly stderr: ChunkQueue;
  readonly exit: Promise<ExecResult>;
  protected readonly stream: ClientChannel;
  #explicitPause = false;
  #queuePause = false;

  constructor(stream: ClientChannel) {
    this.stream = stream;
    this.stdout = new ChunkQueue({
      highWater: STDOUT_HIGH_WATER,
      lowWater: STDOUT_LOW_WATER,
      onPressure: (over) => {
        this.#queuePause = over;
        this.#applyFlow();
      },
    });
    this.stderr = new ChunkQueue({ maxBytes: STDERR_MAX_BYTES });
    let result: ExecResult = { code: null, signal: null };
    stream.on('data', (chunk: Buffer) => this.stdout.push(chunk));
    // ssh2 emits 'close' only after 'end', i.e. once every buffered stdout chunk was delivered.
    stream.on('end', () => this.stdout.end());
    stream.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk));
    stream.stderr.on('end', () => this.stderr.end());
    stream.on('exit', (code: unknown, signal: unknown) => {
      result = {
        code: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? signal : null,
      };
    });
    // Channel errors are followed by 'close'; never let them crash the process.
    stream.on('error', () => {});
    this.exit = new Promise((resolve) => {
      stream.once('close', () => {
        this.stdout.end();
        this.stderr.end();
        resolve(result);
      });
    });
  }

  write(data: Uint8Array): void {
    if (this.stream.writable) this.stream.write(data);
  }

  end(): void {
    if (this.stream.writable) this.stream.end();
  }

  pause(): void {
    this.#explicitPause = true;
    this.#applyFlow();
  }

  resume(): void {
    this.#explicitPause = false;
    this.#applyFlow();
  }

  /** Closes the channel on both sides. */
  close(): void {
    this.stream.close();
  }

  #applyFlow(): void {
    if (this.#explicitPause || this.#queuePause) this.stream.pause();
    else this.stream.resume();
  }
}

export class SshPtyChannel extends SshExecChannel implements PtyChannel {
  resize(dims: Dimensions): void {
    this.stream.setWindow(dims.rows, dims.cols, 0, 0);
  }
}
