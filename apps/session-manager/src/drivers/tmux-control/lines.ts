const LF = 0x0a;

/** tmux 3.8 caps buffered command replies at 64 MiB; nothing legitimate is longer. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Byte-level `\n` line splitter (plan §6.4). Lines are returned without the terminator and are
 * never decoded: `%output` payloads must be unescaped as bytes first.
 */
export class LineSplitter {
  readonly #maxLineBytes: number;
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;

  constructor(maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
    this.#maxLineBytes = maxLineBytes;
  }

  /** Returns every line completed by `chunk`. Returned lines may be views into `chunk`. */
  push(chunk: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = chunk.indexOf(LF); i !== -1; i = chunk.indexOf(LF, start)) {
      const part = chunk.subarray(start, i);
      if (this.#pendingBytes > 0) {
        this.#append(part);
        lines.push(this.#takePending());
      } else {
        lines.push(part);
      }
      start = i + 1;
    }
    if (start < chunk.byteLength) this.#append(chunk.subarray(start));
    return lines;
  }

  /** Bytes after the last `\n` when the stream ended (a truncated line), or null. */
  end(): Uint8Array | null {
    return this.#pendingBytes > 0 ? this.#takePending() : null;
  }

  #append(part: Uint8Array): void {
    if (part.byteLength === 0) return;
    this.#pendingBytes += part.byteLength;
    if (this.#pendingBytes > this.#maxLineBytes) {
      throw new RangeError(`control-mode line exceeds ${this.#maxLineBytes} bytes`);
    }
    // Copy: the caller may reuse the chunk's buffer after push() returns.
    this.#pending.push(part.slice());
  }

  #takePending(): Uint8Array {
    const parts = this.#pending;
    const out = parts.length === 1 ? parts[0]! : concatBytes(parts, this.#pendingBytes);
    this.#pending = [];
    this.#pendingBytes = 0;
    return out;
  }
}

export function concatBytes(parts: readonly Uint8Array[], total?: number): Uint8Array {
  const size = total ?? parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Async-iterable form: yields the lines of a chunk stream (a truncated last line included). */
export async function* splitLines(
  source: AsyncIterable<Uint8Array>,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
): AsyncGenerator<Uint8Array> {
  const splitter = new LineSplitter(maxLineBytes);
  for await (const chunk of source) yield* splitter.push(chunk);
  const rest = splitter.end();
  if (rest) yield rest;
}
