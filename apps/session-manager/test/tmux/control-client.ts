/**
 * Test harness wiring the control-mode building blocks over an exec channel:
 * stdout → LineSplitter → ControlParser → CommandCorrelator, recording raw bytes and events.
 * (The production TmuxControlDriver is a later workstream.)
 */
import type { ExecChannel, ExecResult } from '../../src/core/types.ts';
import {
  type BatchResult,
  CommandCorrelator,
  type CommandResult,
  type ControlEvent,
  ControlParser,
  encodeInput,
  LineSplitter,
} from '../../src/drivers/tmux-control/index.ts';

interface Waiter {
  predicate: (event: ControlEvent) => boolean;
  resolve: (event: ControlEvent) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SentStep {
  atMs: number;
  atByte: number;
  line: string;
}

export class TestControlClient {
  readonly events: ControlEvent[] = [];
  readonly chunks: Array<{ atMs: number; data: Uint8Array }> = [];
  readonly sent: SentStep[] = [];
  readonly errors: Error[] = [];
  readonly exit: Promise<ExecResult>;
  readonly startedAt = Date.now();
  readonly #channel: ExecChannel;
  readonly #splitter = new LineSplitter();
  readonly #parser = new ControlParser();
  readonly #correlator: CommandCorrelator;
  readonly #waiters = new Set<Waiter>();
  #bytes = 0;
  #lastChunkAt = Date.now();
  #ended = false;
  stderr = '';

  constructor(channel: ExecChannel) {
    this.#channel = channel;
    this.#correlator = new CommandCorrelator((line) => {
      this.sent.push({ atMs: this.elapsed(), atByte: this.#bytes, line });
      channel.write(new TextEncoder().encode(`${line}\n`));
    });
    void this.#pumpStderr();
    const pumped = this.#pump();
    this.exit = pumped.then(() => channel.exit);
  }

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  get bytesReceived(): number {
    return this.#bytes;
  }

  send(command: string): Promise<CommandResult> {
    return this.#correlator.send(command);
  }

  sendBatch(commands: string[]): Promise<BatchResult> {
    return this.#correlator.sendBatch(commands);
  }

  /** Types bytes into a pane through `send-keys -H` (pipelined). */
  async input(paneId: number, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const results = await Promise.all(encodeInput(paneId, bytes).map((c) => this.send(c)));
    const failed = results.find((r) => !r.ok);
    if (failed) throw new Error(`send-keys failed: ${decodeLines(failed.lines)}`);
  }

  waitFor(predicate: (event: ControlEvent) => boolean, timeoutMs = 10_000): Promise<ControlEvent> {
    const seen = this.events.find(predicate);
    if (seen) return Promise.resolve(seen);
    return this.#wait(predicate, timeoutMs);
  }

  /** Waits for a matching event received after this call. */
  next(predicate: (event: ControlEvent) => boolean, timeoutMs = 10_000): Promise<ControlEvent> {
    return this.#wait(predicate, timeoutMs);
  }

  /** Resolves once no stdout arrived for `quietMs`. */
  async waitIdle(quietMs = 300, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const quietFor = Date.now() - this.#lastChunkAt;
      if (quietFor >= quietMs || this.#ended) return;
      if (Date.now() > deadline) throw new Error('control client never went idle');
      await new Promise((r) => setTimeout(r, quietMs - quietFor));
    }
  }

  /** Concatenated unescaped `%output` bytes of a pane, decoded as UTF-8. */
  outputText(paneId: number): string {
    const parts: Uint8Array[] = [];
    for (const e of this.events) {
      if ((e.type === 'output' || e.type === 'extendedOutput') && e.paneId === paneId) {
        parts.push(e.data);
      }
    }
    return Buffer.concat(parts).toString('utf8');
  }

  raw(): Uint8Array {
    return Buffer.concat(this.chunks.map((c) => c.data));
  }

  /** Closes stdin: the control client detaches and exits. */
  detach(): void {
    this.#channel.end();
  }

  #wait(predicate: (event: ControlEvent) => boolean, timeoutMs: number): Promise<ControlEvent> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`timed out waiting for a control event (${timeoutMs} ms)`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  async #pump(): Promise<void> {
    try {
      for await (const chunk of this.#channel.stdout) {
        this.#lastChunkAt = Date.now();
        this.chunks.push({ atMs: this.elapsed(), data: chunk });
        this.#bytes += chunk.byteLength;
        for (const line of this.#splitter.push(chunk)) this.#dispatch(line);
      }
    } finally {
      this.#ended = true;
      this.#correlator.failAll(new Error('control channel closed'));
      for (const waiter of this.#waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('control channel closed'));
      }
      this.#waiters.clear();
    }
  }

  async #pumpStderr(): Promise<void> {
    for await (const chunk of this.#channel.stderr) this.stderr += Buffer.from(chunk).toString();
  }

  #dispatch(line: Uint8Array): void {
    const event = this.#parser.push(line);
    if (!event) return;
    try {
      this.#correlator.handle(event);
    } catch (err) {
      this.errors.push(err as Error);
    }
    this.events.push(event);
    for (const waiter of this.#waiters) {
      if (waiter.predicate(event)) {
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    }
  }
}

export function decodeLines(lines: readonly Uint8Array[]): string {
  return lines.map((l) => Buffer.from(l).toString('utf8')).join('\n');
}
