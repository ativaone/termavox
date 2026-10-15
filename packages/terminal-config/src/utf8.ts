/**
 * UTF-8 boundary alignment for `term.write()` (ADR-0001).
 *
 * xterm 6.0.0's UTF-8 decoder drops a character when a write ends right after a continuation
 * byte equal to 0x80 (its interim-byte loop stops at a zero payload): e.g. U+2014 "—", U+2026
 * "…", U+201C "“", U+2022 "•", U+200D ZWJ (all `E2 80 xx`) and emoji such as U+1F004. Chunk
 * boundaries differ between the server and the browser, so both sides must only hand complete
 * UTF-8 sequences to xterm. Invalid bytes are passed through untouched.
 */

const EMPTY = new Uint8Array(0);

/** Length of the prefix of `data` that ends on a UTF-8 character boundary. */
export function utf8CompleteLength(data: Uint8Array): number {
  const n = data.length;
  for (let i = n - 1; i >= 0 && i >= n - 4; i--) {
    const b = data[i]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf8 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return i + need > n ? i : n;
  }
  return n;
}

/** Carries an incomplete trailing UTF-8 sequence (≤ 3 bytes) over to the next chunk. */
export class Utf8Aligner {
  private carry: Uint8Array = EMPTY;

  /** Returns the complete part of (carried bytes + data); keeps the incomplete tail. */
  push(data: Uint8Array): Uint8Array {
    let bytes = data;
    if (this.carry.length) {
      bytes = new Uint8Array(this.carry.length + data.length);
      bytes.set(this.carry);
      bytes.set(data, this.carry.length);
    }
    const complete = utf8CompleteLength(bytes);
    this.carry = complete === bytes.length ? EMPTY : bytes.slice(complete);
    return complete === bytes.length ? bytes : bytes.subarray(0, complete);
  }

  /** Bytes received but held back (an incomplete character). */
  get pending(): Uint8Array {
    return this.carry;
  }
}
