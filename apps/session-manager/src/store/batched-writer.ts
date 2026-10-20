import type { TermavoxDb } from '@termavox/db';
import { type Logger, silentLogger } from '../config/logger.ts';
import type { Sqlite } from './sqlite.ts';

/**
 * Async batched writer for every daemon write (plan §9, "Writers and lock waits").
 *
 * - Writes are queued and flushed on `setImmediate` in short `BEGIN IMMEDIATE` transactions
 *   (at most `maxBatch` ops each), so the data plane never waits on a lock in its hot path.
 * - The daemon connection uses `busy_timeout` 250 ms. A batch that fails with SQLITE_BUSY is
 *   rolled back as a whole and retried later with a bounded exponential backoff; the ops stay at
 *   the head of the queue, so nothing is lost or reordered.
 * - Each op runs inside its own savepoint: an op that fails for any other reason (e.g. a foreign
 *   key whose parent row was deleted) is rolled back and dropped (logged; `run()` rejects), and
 *   the rest of the batch commits. A poisoned op must not stall the queue forever.
 * - Consecutive keyed updates (`enqueueUpdate` with the same key at the tail of the queue) are
 *   coalesced into one write. Only the tail is merged, so writes never move across other ops.
 * - After `close()` the writer writes through synchronously (late callbacks during teardown).
 */
export type WriteFn<T = unknown> = (sqlite: Sqlite) => T;

interface Op {
  label: string;
  write: WriteFn;
  key?: string;
  patch?: Record<string, unknown>;
  settle?: { resolve(value: unknown): void; reject(err: unknown): void };
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

export interface BatchedWriterOptions {
  logger?: Logger;
  /** Ops per transaction (keeps transactions short). */
  maxBatch?: number;
  /** First retry delay after SQLITE_BUSY; doubles up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export const DEFAULT_MAX_BATCH = 200;
export const DEFAULT_RETRY_BASE_MS = 25;
export const DEFAULT_RETRY_MAX_MS = 2_000;

export class BatchedWriter {
  readonly #sqlite: Sqlite;
  readonly #log: Logger;
  readonly #maxBatch: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  #queue: Op[] = [];
  #immediate: ReturnType<typeof setImmediate> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #failures = 0;
  #closed = false;
  #flushing = false;
  #drainWaiters: Array<() => void> = [];
  /** Committed transactions (diagnostics and tests). */
  committedBatches = 0;

  constructor(db: TermavoxDb, options: BatchedWriterOptions = {}) {
    this.#sqlite = db.$client;
    this.#log = (options.logger ?? silentLogger()).child({ component: 'db-writer' });
    this.#maxBatch = Math.max(1, options.maxBatch ?? DEFAULT_MAX_BATCH);
    this.#retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.#retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  }

  /** Ops waiting to be committed. */
  get pendingCount(): number {
    return this.#queue.length;
  }

  /** Fire-and-forget write. */
  enqueue(label: string, write: WriteFn<void>): void {
    this.#push({ label, write });
  }

  /**
   * Fire-and-forget keyed update. When the tail of the queue is an update with the same key,
   * the patch is merged into it (later fields win) instead of queuing another write.
   */
  enqueueUpdate<P extends object>(
    key: string,
    patch: P,
    write: (sqlite: Sqlite, patch: P) => void,
  ): void {
    const tail = this.#queue.at(-1);
    if (!this.#closed && tail?.key === key && tail.patch) {
      Object.assign(tail.patch, patch);
      return;
    }
    const merged = { ...patch } as Record<string, unknown>;
    this.#push({ label: key, key, patch: merged, write: (sqlite) => write(sqlite, merged as P) });
  }

  /** Merged patch of the queued (not yet committed) updates for `key`: read-your-writes. */
  pending(key: string): Record<string, unknown> | undefined {
    let merged: Record<string, unknown> | undefined;
    for (const op of this.#queue) {
      if (op.key === key && op.patch) merged = { ...merged, ...op.patch };
    }
    return merged;
  }

  /** Write in queue order; resolves with the write's result once committed. */
  run<T>(label: string, write: WriteFn<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#push({
        label,
        write,
        settle: { resolve: resolve as (value: unknown) => void, reject },
      });
    });
  }

  /**
   * Commits everything queued now (skipping a pending backoff wait), retrying SQLITE_BUSY on the
   * backoff schedule. Resolves true once drained, false when `timeoutMs` elapsed first.
   */
  flush(timeoutMs = 5_000): Promise<boolean> {
    if (this.#queue.length === 0) return Promise.resolve(true);
    const drained = new Promise<boolean>((resolve) => {
      this.#drainWaiters.push(() => resolve(true));
    });
    this.#cancelTimers();
    this.#flushNow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return Promise.race([drained, timeout]).finally(() => clearTimeout(timer));
  }

  /** Flushes, then switches to synchronous write-through. Returns whether the flush drained. */
  async close(timeoutMs = 5_000): Promise<boolean> {
    const drained = await this.flush(timeoutMs);
    if (!drained) {
      this.#log.error({ pending: this.#queue.length }, 'writer closed with uncommitted writes');
    }
    this.#closed = true;
    this.#cancelTimers();
    return drained;
  }

  #push(op: Op): void {
    this.#queue.push(op);
    if (this.#closed) {
      this.#flushNow();
      return;
    }
    if (!this.#immediate && !this.#retryTimer) {
      this.#immediate = setImmediate(() => {
        this.#immediate = null;
        this.#flushNow();
      });
    }
  }

  #cancelTimers(): void {
    if (this.#immediate) clearImmediate(this.#immediate);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#immediate = null;
    this.#retryTimer = null;
  }

  #flushNow(): void {
    if (this.#queue.length === 0) {
      this.#drained();
      return;
    }
    // A write that enqueues (write-through after close) must not nest into the running batch;
    // the outer flush picks the new op up when it checks the queue again.
    if (this.#flushing) return;
    const batch = this.#queue.slice(0, this.#maxBatch);
    let outcomes: Outcome[];
    this.#flushing = true;
    try {
      outcomes = this.#runBatch(batch);
    } catch (err) {
      this.#batchFailed(err);
      return;
    } finally {
      this.#flushing = false;
    }
    this.#queue.splice(0, batch.length);
    this.#failures = 0;
    this.committedBatches++;
    batch.forEach((op, i) => {
      const outcome = outcomes[i]!;
      if (outcome.ok) {
        op.settle?.resolve(outcome.value);
        return;
      }
      // `run()` callers handle their own rejections (e.g. a 404 thrown inside the write).
      if (op.settle) op.settle.reject(outcome.error);
      else this.#log.warn({ op: op.label, err: describeDbError(outcome.error) }, 'write dropped');
    });
    if (this.#queue.length === 0) {
      this.#drained();
      return;
    }
    if (this.#closed) {
      this.#flushNow();
      return;
    }
    // More than one batch queued: yield to the event loop between transactions.
    this.#immediate ??= setImmediate(() => {
      this.#immediate = null;
      this.#flushNow();
    });
  }

  #runBatch(batch: Op[]): Outcome[] {
    const sqlite = this.#sqlite;
    const outcomes: Outcome[] = [];
    sqlite
      .transaction(() => {
        for (const op of batch) {
          try {
            // Nested transaction = SAVEPOINT: a failing op rolls back alone.
            outcomes.push({ ok: true, value: sqlite.transaction(() => op.write(sqlite))() });
          } catch (err) {
            if (isBusyError(err)) throw err;
            outcomes.push({ ok: false, error: err });
          }
        }
      })
      .immediate();
    return outcomes;
  }

  #batchFailed(err: unknown): void {
    const busy = isBusyError(err);
    if (this.#closed) {
      // Write-through after close: no retries; report and drop.
      const dropped = this.#queue.splice(0);
      this.#log.error({ err: describeDbError(err), dropped: dropped.length }, 'write failed');
      for (const op of dropped) op.settle?.reject(err);
      this.#drained();
      return;
    }
    const delay = Math.min(this.#retryMaxMs, this.#retryBaseMs * 2 ** this.#failures);
    this.#failures++;
    const fields = { err: describeDbError(err), retryInMs: delay, pending: this.#queue.length };
    if (busy) this.#log.debug(fields, 'database busy; flush retried later');
    else this.#log.error(fields, 'flush failed; retried later');
    this.#cancelTimers();
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#flushNow();
    }, delay);
  }

  #drained(): void {
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const waiter of waiters) waiter();
  }
}

/** Walks an error and its causes (drizzle wraps driver errors) for an SQLite error code. */
export function sqliteErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_')) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function isBusyError(err: unknown): boolean {
  const code = sqliteErrorCode(err);
  return code !== null && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}

/**
 * Loggable summary of a DB error: the SQLite code and the driver message, never the drizzle
 * wrapper message (it embeds the query parameters).
 */
export function describeDbError(err: unknown): { code: string | null; message: string } {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_')) {
      return { code, message: String((current as Error).message) };
    }
    const cause = (current as { cause?: unknown }).cause;
    if (!cause) break;
    current = cause;
  }
  if (err instanceof Error && err.name !== 'DrizzleQueryError') {
    return { code: null, message: err.message };
  }
  return { code: null, message: 'database error' };
}
