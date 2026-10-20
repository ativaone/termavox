import { FILES_LIMITS, type TransferState } from '@termdock/protocol';
import { ErrorCode, isTermdockError, TermdockError } from '@termdock/shared';
import {
  matches,
  type TransferDirection,
  type TransferGrant,
  type TransferGrantInput,
  TransferTokens,
} from './transfer-tokens.ts';

/** `files.progress` and `transfer.progress` while something runs: at most four per second. */
export const PROGRESS_INTERVAL_MS = 250;
/**
 * Transfers the process runs at once, all users together (each holds a remote file handle and its
 * session's SFTP channel); the next one is RATE_LIMITED.
 */
export const MAX_RUNNING_TRANSFERS = 64;

/** How a transfer ended: what its last `transfer.progress` says. */
export type TransferEnd =
  | { state: 'done' }
  | { state: 'cancelled' }
  | { state: 'failed'; code: string };

/**
 * Why a running transfer was stopped from outside: by its user (`cancelled`), or by the daemon
 * (`failed` with the code: a sign-out, the shutdown, an upload that stopped sending).
 */
export class TransferStop extends TermdockError {
  readonly end: Exclude<TransferEnd, { state: 'done' }>;

  constructor(end: Exclude<TransferEnd, { state: 'done' }>, message: string) {
    super(end.state === 'failed' ? (end.code as ErrorCode) : ErrorCode.Cancelled, message);
    this.end = end;
  }
}

/** The end a failure gives a transfer: a stop says it, any other error is `failed` with its code. */
export function endOf(err: unknown): Exclude<TransferEnd, { state: 'done' }> {
  if (err instanceof TransferStop) return err.end;
  return { state: 'failed', code: isTermdockError(err) ? err.code : ErrorCode.Internal };
}

/** One upload or download from the moment its URL was used until its last progress. */
export class ActiveTransfer {
  readonly grant: TransferGrant;
  readonly #abort = new AbortController();
  readonly #now: () => number;
  readonly #onEnd: () => void;
  #size: number;
  #bytes = 0;
  #sentAt = 0;
  #started = false;
  #ended = false;
  #state: TransferState = 'running';
  #trailing: ReturnType<typeof setTimeout> | null = null;

  constructor(grant: TransferGrant, now: () => number, onEnd: () => void) {
    this.grant = grant;
    this.#size = grant.size;
    this.#now = now;
    this.#onEnd = onEnd;
  }

  get transferId(): string {
    return this.grant.transferId;
  }

  /** Aborted (with a TransferStop as its reason) when the transfer is stopped from outside. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** `running` until it ended, then how. */
  get state(): TransferState {
    return this.#state;
  }

  stop(reason: TransferStop): void {
    if (!this.#ended) this.#abort.abort(reason);
  }

  /** The bytes are about to flow; `size` is what will be sent (a download: from fstat). */
  start(size: number = this.#size): void {
    if (this.#started || this.#ended) return;
    this.#started = true;
    this.#size = size;
    this.#sentAt = this.#now();
    this.#send('running');
  }

  /**
   * Bytes moved so far; told to the browser at most every PROGRESS_INTERVAL_MS. A count held back
   * goes out when the interval is over, so a stalled transfer still shows what it moved.
   */
  progress(bytes: number): void {
    if (this.#ended) return;
    this.#bytes = bytes;
    const wait = this.#sentAt + PROGRESS_INTERVAL_MS - this.#now();
    if (wait > 0) {
      if (!this.#trailing) {
        this.#trailing = setTimeout(() => {
          this.#trailing = null;
          if (this.#ended) return;
          this.#sentAt = this.#now();
          this.#send('running');
        }, wait);
        this.#trailing.unref();
      }
      return;
    }
    if (this.#trailing) clearTimeout(this.#trailing);
    this.#trailing = null;
    this.#sentAt = this.#now();
    this.#send('running');
  }

  /** The last progress; later calls do nothing. */
  finish(end: TransferEnd): void {
    if (this.#ended) return;
    if (this.#trailing) clearTimeout(this.#trailing);
    this.#trailing = null;
    this.#ended = true;
    this.#state = end.state;
    this.#send(end.state, end.state === 'failed' ? end.code : undefined);
    this.#onEnd();
  }

  #send(state: TransferState, code?: string): void {
    try {
      this.grant.notify({
        type: 'transfer.progress',
        transferId: this.grant.transferId,
        bytes: this.#bytes,
        size: this.#size,
        state,
        ...(code !== undefined ? { code } : {}),
      });
    } catch {
      // The minting connection is gone: the transfer goes on without progress.
    }
  }
}

/**
 * The transfers of the process (plan §5.12): their single-use URLs, the ones running (at most
 * FILES_LIMITS.transfersPerUser per user and MAX_RUNNING_TRANSFERS in all), and stopping them: one
 * by its user, all of a user or auth session when it is revoked, all at shutdown.
 */
export class Transfers {
  readonly tokens: TransferTokens;
  readonly #running = new Set<ActiveTransfer>();
  readonly #drainWaiters: Array<() => void> = [];
  readonly #now: () => number;
  readonly #perUser: number;
  readonly #maxRunning: number;
  #closed = false;

  constructor(
    options: { now?: () => number; ttlMs?: number; perUser?: number; maxRunning?: number } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#perUser = options.perUser ?? FILES_LIMITS.transfersPerUser;
    this.#maxRunning = options.maxRunning ?? MAX_RUNNING_TRANSFERS;
    this.tokens = new TransferTokens({
      now: this.#now,
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    });
  }

  /** Running transfers (of one user). */
  running(userId?: string): ActiveTransfer[] {
    return [...this.#running].filter((t) => userId === undefined || t.grant.userId === userId);
  }

  mint(input: TransferGrantInput): { token: string; grant: TransferGrant } {
    if (this.#closed) throw new TermdockError(ErrorCode.SessionNotConnected, 'shutting down');
    return this.tokens.mint(input);
  }

  consume(token: string, direction: TransferDirection): TransferGrant | null {
    return this.#closed ? null : this.tokens.consume(token, direction);
  }

  /**
   * A used URL's transfer begins; RATE_LIMITED while its user, or the whole process, already runs
   * the maximum.
   */
  begin(grant: TransferGrant): ActiveTransfer {
    if (this.#closed) throw new TermdockError(ErrorCode.SessionNotConnected, 'shutting down');
    if (this.running(grant.userId).length >= this.#perUser) {
      throw new TermdockError(ErrorCode.RateLimited, 'too many transfers at once');
    }
    if (this.#running.size >= this.#maxRunning) {
      throw new TermdockError(ErrorCode.RateLimited, 'the server runs too many transfers at once');
    }
    const transfer = new ActiveTransfer(grant, this.#now, () => {
      this.#running.delete(transfer);
      if (this.#running.size === 0) for (const wake of this.#drainWaiters.splice(0)) wake();
    });
    this.#running.add(transfer);
    return transfer;
  }

  /** Resolves once no transfer runs, or after `timeoutMs`. */
  async drained(timeoutMs: number): Promise<void> {
    if (this.#running.size === 0) return;
    const done = Promise.withResolvers<void>();
    this.#drainWaiters.push(done.resolve);
    const timer = setTimeout(done.resolve, timeoutMs);
    await done.promise;
    clearTimeout(timer);
  }

  /** `transfer.cancel`: stops the user's transfer, or voids its unused URL. */
  cancel(userId: string, transferId: string): boolean {
    for (const transfer of this.#running) {
      if (transfer.grant.userId === userId && transfer.transferId === transferId) {
        transfer.stop(new TransferStop({ state: 'cancelled' }, 'cancelled'));
        return true;
      }
    }
    return this.tokens.void(userId, transferId);
  }

  /** Sign-out, password change, ban: the user's (or auth session's) transfers and URLs end. */
  revoke(target: { userId?: string; authSessionId?: string }): void {
    this.tokens.revoke(target);
    const stop = new TransferStop(
      { state: 'failed', code: ErrorCode.Unauthenticated },
      'the sign-in was revoked',
    );
    for (const transfer of this.#running) if (matches(transfer.grant, target)) transfer.stop(stop);
  }

  /** Daemon shutdown: nothing new starts, everything running stops. */
  close(): void {
    this.#closed = true;
    this.tokens.clear();
    const stop = new TransferStop(
      { state: 'failed', code: ErrorCode.Cancelled },
      'the server is shutting down',
    );
    for (const transfer of this.#running) transfer.stop(stop);
  }
}
