export interface ChunkQueueOptions {
  /** Buffered bytes at or above which `onPressure(true)` fires. */
  highWater?: number;
  /** Buffered bytes at or below which `onPressure(false)` fires again. */
  lowWater?: number;
  onPressure?: (overHighWater: boolean) => void;
  /** Hard cap: when exceeded, the oldest chunks are dropped (stderr-style sinks). */
  maxBytes?: number;
}

/**
 * Push-fed, single-consumer async iterable of byte chunks. Producers push from stream events;
 * the consumer iterates. Water marks let the producer apply backpressure at its source.
 * If the consumer stops iterating early, further chunks are discarded.
 */
export class ChunkQueue implements AsyncIterable<Uint8Array> {
  readonly #chunks: Uint8Array[] = [];
  readonly #options: ChunkQueueOptions;
  #head = 0;
  #bytes = 0;
  #ended = false;
  #error: Error | null = null;
  #discard = false;
  #pressure = false;
  #iterated = false;
  #wake: (() => void) | null = null;

  constructor(options: ChunkQueueOptions = {}) {
    this.#options = options;
  }

  get bufferedBytes(): number {
    return this.#bytes;
  }

  push(chunk: Uint8Array): void {
    if (this.#ended || this.#discard || chunk.byteLength === 0) return;
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    const max = this.#options.maxBytes;
    if (max !== undefined) {
      while (this.#bytes > max && this.#head < this.#chunks.length - 1) this.#shift();
    }
    const high = this.#options.highWater;
    if (high !== undefined && !this.#pressure && this.#bytes >= high) this.#setPressure(true);
    this.#notify();
  }

  end(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    if (error) this.#error = error;
    this.#notify();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#iterated) throw new Error('ChunkQueue supports a single consumer');
    this.#iterated = true;
    return {
      next: async () => {
        for (;;) {
          if (this.#head < this.#chunks.length) return { done: false, value: this.#shift() };
          if (this.#ended) {
            if (this.#error) throw this.#error;
            return { done: true, value: undefined };
          }
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
        }
      },
      return: async () => {
        this.#discard = true;
        this.#chunks.length = 0;
        this.#head = 0;
        this.#bytes = 0;
        if (this.#pressure) this.#setPressure(false);
        return { done: true, value: undefined };
      },
    };
  }

  #shift(): Uint8Array {
    const chunk = this.#chunks[this.#head]!;
    this.#head++;
    this.#bytes -= chunk.byteLength;
    if (this.#head > 1024 && this.#head * 2 > this.#chunks.length) {
      this.#chunks.splice(0, this.#head);
      this.#head = 0;
    }
    const low = this.#options.lowWater ?? 0;
    if (this.#pressure && this.#bytes <= low) this.#setPressure(false);
    return chunk;
  }

  #setPressure(value: boolean): void {
    this.#pressure = value;
    this.#options.onPressure?.(value);
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}
