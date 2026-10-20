import { setImmediate as nextTurn } from 'node:timers/promises';
import { type Logger, silentLogger } from '../config/logger.ts';
import { type BatchedWriter, describeDbError } from './batched-writer.ts';
import { execute } from './sqlite.ts';

/**
 * Event retention (plan §10.2, §9): `audit_events` and `session_events` rows older than
 * TERMAVOX_EVENT_RETENTION_DAYS are deleted. The purge applies to the tables, whoever wrote the
 * rows, so web's audit events (sign-ins, admin actions) age out with the daemon's own.
 *
 * - A purge deletes the oldest rows first, `chunkRows` per write, each write one op of the
 *   batched writer (a short `BEGIN IMMEDIATE` transaction, SQLITE_BUSY retried by the writer).
 *   It yields to the event loop between chunks, so session writes queued meanwhile commit before
 *   the next chunk: never one large delete. Both tables have an index on `created_at`.
 * - The job runs a few minutes after boot, then every 6 hours, on unref'd timers. `stop()` (at
 *   shutdown) clears the timer and ends a running purge before its next chunk.
 * - Logs carry the per-table counts and the cutoff, never row contents.
 */
export const RETENTION_TABLES = ['audit_events', 'session_events'] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];
export type PurgeCounts = Record<RetentionTable, number>;

export const PURGE_CHUNK_ROWS = 500;
export const PURGE_INITIAL_DELAY_MS = 5 * 60_000;
export const PURGE_INTERVAL_MS = 6 * 60 * 60_000;
export const DAY_MS = 86_400_000;

export interface PurgeOptions {
  writer: BatchedWriter;
  /** Rows whose `created_at` (epoch ms) is below this are deleted. */
  cutoff: number;
  chunkRows?: number;
  /** Checked before every chunk: true ends the purge early. */
  stopped?: () => boolean;
}

export interface PurgeResult {
  deleted: PurgeCounts;
  /** Delete statements run (one writer op each). */
  chunks: number;
  /** False when `stopped` ended the purge before every old row was gone. */
  complete: boolean;
}

/** Deletes every event row older than `cutoff`, chunk by chunk, through the batched writer. */
export async function purgeEvents(options: PurgeOptions): Promise<PurgeResult> {
  const chunkRows = Math.max(1, Math.floor(options.chunkRows ?? PURGE_CHUNK_ROWS));
  const result: PurgeResult = {
    deleted: { audit_events: 0, session_events: 0 },
    chunks: 0,
    complete: false,
  };
  for (const table of RETENTION_TABLES) {
    // `table` comes from the constant list above, never from input.
    const sql = `DELETE FROM ${table} WHERE rowid IN (
       SELECT rowid FROM ${table} WHERE created_at < ? ORDER BY created_at LIMIT ?)`;
    for (;;) {
      if (options.stopped?.()) return result;
      const deleted = await options.writer.run(`retention:${table}`, (sqlite) =>
        execute(sqlite, sql, options.cutoff, chunkRows),
      );
      result.chunks++;
      result.deleted[table] += deleted;
      if (deleted < chunkRows) break;
      // Other writes queued meanwhile go first: the next chunk joins the end of the queue.
      await nextTurn();
    }
  }
  result.complete = true;
  return result;
}

export interface RetentionJobOptions {
  writer: BatchedWriter;
  /** TERMAVOX_EVENT_RETENTION_DAYS; 0 disables the job. */
  retentionDays: number;
  logger?: Logger;
  /** Clock for the cutoff (tests). */
  now?: () => number;
  chunkRows?: number;
  initialDelayMs?: number;
  intervalMs?: number;
  /** Replaces the purge itself (schedule tests). */
  purge?: (options: PurgeOptions) => Promise<PurgeResult>;
}

/** The periodic purge: `start()` once the daemon is up, `stop()` at shutdown. */
export class RetentionJob {
  readonly #writer: BatchedWriter;
  readonly #days: number;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #chunkRows: number;
  readonly #initialDelayMs: number;
  readonly #intervalMs: number;
  readonly #purge: (options: PurgeOptions) => Promise<PurgeResult>;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #stopped = false;

  constructor(options: RetentionJobOptions) {
    this.#writer = options.writer;
    this.#days = options.retentionDays;
    this.#log = (options.logger ?? silentLogger()).child({ component: 'retention' });
    this.#now = options.now ?? Date.now;
    this.#chunkRows = options.chunkRows ?? PURGE_CHUNK_ROWS;
    this.#initialDelayMs = options.initialDelayMs ?? PURGE_INITIAL_DELAY_MS;
    this.#intervalMs = options.intervalMs ?? PURGE_INTERVAL_MS;
    this.#purge = options.purge ?? purgeEvents;
  }

  /** False when retention is 0 days: rows are kept forever and nothing is scheduled. */
  get enabled(): boolean {
    return this.#days > 0;
  }

  /** A purge is waiting on its timer. */
  get scheduled(): boolean {
    return this.#timer !== null;
  }

  /** Schedules the first purge `initialDelayMs` from now (only logs when disabled). */
  start(): void {
    if (this.#stopped || this.#timer || this.#running) return;
    if (!this.enabled) {
      this.#log.info('event retention off: audit and session events are kept forever');
      return;
    }
    this.#log.info(
      { retentionDays: this.#days, firstRunInMs: this.#initialDelayMs },
      'event retention scheduled',
    );
    this.#schedule(this.#initialDelayMs);
  }

  /** Runs one purge now; a call during a running purge shares it. */
  run(): Promise<void> {
    if (!this.enabled || this.#stopped) return Promise.resolve();
    this.#running ??= this.#runPurge().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /**
   * Clears the timer; a running purge ends before its next chunk (a chunk already queued commits
   * with the writer's next flush). Resolves when that purge has ended. Idempotent.
   */
  stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    return this.#running ?? Promise.resolve();
  }

  #schedule(delayMs: number): void {
    const timer = setTimeout(() => {
      this.#timer = null;
      void this.run().then(() => {
        if (!this.#stopped) this.#schedule(this.#intervalMs);
      });
    }, delayMs);
    // Never keeps the process alive.
    timer.unref();
    this.#timer = timer;
  }

  async #runPurge(): Promise<void> {
    const startedAt = performance.now();
    const cutoff = this.#now() - this.#days * DAY_MS;
    const fields = { retentionDays: this.#days, cutoff: new Date(cutoff).toISOString() };
    try {
      const result = await this.#purge({
        writer: this.#writer,
        cutoff,
        chunkRows: this.#chunkRows,
        stopped: () => this.#stopped,
      });
      this.#log.info(
        {
          ...fields,
          deleted: result.deleted,
          chunks: result.chunks,
          complete: result.complete,
          durationMs: Math.round(performance.now() - startedAt),
        },
        result.complete ? 'event retention purge finished' : 'event retention purge stopped',
      );
    } catch (err) {
      // E.g. a disk error: the rows stay, and the next run tries again.
      this.#log.warn({ ...fields, err: describeDbError(err) }, 'event retention purge failed');
    }
  }
}
