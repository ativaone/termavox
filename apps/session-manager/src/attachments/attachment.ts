import type { AttachmentHandle, Dimensions } from '../core/types.ts';
import { encodeOutputFrame } from './wire.ts';

/** Coalescing (plan §5.4): one OUTPUT frame every 8 ms or per 64 KiB, whichever comes first. */
export const COALESCE_MS = 8;
export const COALESCE_BYTES = 64 * 1024;
/** Socket backpressure (plan §5.5). */
export const LAG_HIGH_WATER = 2 * 1024 * 1024;
export const LAG_LOW_WATER = 256 * 1024;
export const LAG_POLL_MS = 50;

type Held = { seq: number; chunk: Uint8Array } | { message: Uint8Array };

export interface AttachmentOptions {
  /** Called once the socket drained below the low water mark after lagging. */
  onRecovered(attachment: Attachment): void;
  lagPollMs?: number;
}

/**
 * The runtime's view of one attachment: its viewport and an ordered outbound queue.
 *
 * - `live`: OUTPUT chunks are coalesced; a control message first flushes the pending output, so
 *   it lands exactly after the bytes that preceded it (sequenced resize, §5.5).
 * - `syncing`: a snapshot is being taken; output and messages are held in order and replayed
 *   after the SNAPSHOT frame (only chunks with seq > snapshotSeq).
 * - `lagging`: the socket is over 2 MiB behind; nothing is sent until it drains below 256 KiB,
 *   then the runtime resyncs it with a fresh snapshot.
 */
export class Attachment {
  readonly id: string;
  readonly handle: AttachmentHandle;
  viewport: Dimensions;
  #mode: 'syncing' | 'live' | 'lagging' = 'syncing';
  #syncToken = 0;
  #held: Held[] = [];
  #chunks: Uint8Array[] = [];
  #bytes = 0;
  #lastSeq = 0;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #lagTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  readonly #options: AttachmentOptions;

  constructor(handle: AttachmentHandle, viewport: Dimensions, options: AttachmentOptions) {
    this.id = handle.id;
    this.handle = handle;
    this.viewport = viewport;
    this.#options = options;
  }

  get mode(): 'syncing' | 'live' | 'lagging' {
    return this.#mode;
  }

  output(seq: number, chunk: Uint8Array): void {
    if (this.#mode === 'lagging' || this.#disposed) return;
    if (this.#mode === 'syncing') {
      this.#held.push({ seq, chunk });
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    this.#lastSeq = seq;
    if (this.#bytes >= COALESCE_BYTES) this.flush();
    else this.#flushTimer ??= setTimeout(() => this.flush(), COALESCE_MS);
  }

  /** A channel-scoped control message, ordered after every output pushed before it. */
  message(frame: Uint8Array): void {
    if (this.#mode === 'lagging' || this.#disposed) return;
    if (this.#mode === 'syncing') {
      this.#held.push({ message: frame });
      return;
    }
    this.flush();
    if (this.#mode === 'live') this.#send(frame);
  }

  /** Sends the coalesced output as one OUTPUT frame carrying the seq of its last chunk. */
  flush(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#bytes === 0 || this.#mode !== 'live') return;
    const payload =
      this.#chunks.length === 1 ? this.#chunks[0]! : concat(this.#chunks, this.#bytes);
    this.#chunks = [];
    this.#bytes = 0;
    this.#send(encodeOutputFrame(this.#lastSeq, payload));
  }

  /**
   * Starts a resync: everything queued so far is covered by the snapshot about to be taken.
   * Returns a token; only the matching `completeSync` takes effect.
   */
  beginSync(): number {
    this.#clearOutbound();
    this.#mode = 'syncing';
    return ++this.#syncToken;
  }

  completeSync(token: number, snapshotFrame: Uint8Array, snapshotSeq: number): void {
    if (token !== this.#syncToken || this.#mode !== 'syncing' || this.#disposed) return;
    const held = this.#held;
    this.#held = [];
    this.#mode = 'live';
    this.#lastSeq = snapshotSeq;
    this.#send(snapshotFrame);
    for (const item of held) {
      if ('message' in item) this.message(item.message);
      else if (item.seq > snapshotSeq) this.output(item.seq, item.chunk);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearOutbound();
    if (this.#lagTimer) clearTimeout(this.#lagTimer);
    this.#lagTimer = null;
  }

  #send(frame: Uint8Array): void {
    if (this.#disposed) return;
    this.handle.send(frame);
    if (this.handle.bufferedAmount > LAG_HIGH_WATER) this.#startLagging();
  }

  #startLagging(): void {
    this.#clearOutbound();
    this.#mode = 'lagging';
    this.#syncToken++; // a snapshot in flight is stale now
    const poll = (): void => {
      this.#lagTimer = null;
      if (this.#disposed || this.#mode !== 'lagging') return;
      if (this.handle.bufferedAmount < LAG_LOW_WATER) this.#options.onRecovered(this);
      else this.#lagTimer = setTimeout(poll, this.#options.lagPollMs ?? LAG_POLL_MS);
    };
    this.#lagTimer = setTimeout(poll, this.#options.lagPollMs ?? LAG_POLL_MS);
  }

  #clearOutbound(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    this.#chunks = [];
    this.#bytes = 0;
    this.#held = [];
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
