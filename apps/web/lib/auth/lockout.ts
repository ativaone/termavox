import '../server-guard.ts';

/**
 * Sign-in lockout per (username, client IP) with a progressive delay (plan §10.2, ADR-0004).
 * After `threshold` consecutive failures the pair is locked for `baseLockMs`, doubling with each
 * further failure up to `maxLockMs`. It is never a global account lock, so failures from one IP
 * cannot lock the account out from another.
 *
 * Each client IP also has a sign-in budget: `ipAttempts` attempts per `ipWindowMs` window, spent by
 * every attempt that passes the pair check, whatever its outcome. It keeps one address from
 * spraying passwords across usernames (each one a fresh pair) and from burning argon2 time.
 * Better Auth's per-IP limiter does not cover sign-in: it only runs on HTTP requests, and the
 * login form signs in through a Server Action (`auth.api`, in process).
 *
 * State lives in memory: the MVP runs a single web instance, and a restart clears the counters.
 * Refused attempts (a locked pair or a spent budget) are rejected before the password is checked
 * and spend nothing: they neither extend the lock nor use up the budget.
 */
export interface LockoutPolicy {
  threshold: number;
  baseLockMs: number;
  maxLockMs: number;
  /** A pair with no failure for this long (and no running lock) is forgotten. */
  forgetAfterMs: number;
  /** Sign-in attempts one client IP may make per window, successes included. */
  ipAttempts: number;
  /** The IP budget's fixed window, starting at the first attempt after the previous one ended. */
  ipWindowMs: number;
  /** Bound on tracked pairs, and separately on tracked IPs; running locks are dropped last. */
  maxEntries: number;
}

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  threshold: 5,
  baseLockMs: 30_000,
  maxLockMs: 15 * 60_000,
  forgetAfterMs: 60 * 60_000,
  ipAttempts: 10,
  ipWindowMs: 60_000,
  maxEntries: 10_000,
};

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

interface IpWindow {
  startedAt: number;
  attempts: number;
}

export class LoginLockout {
  readonly #entries = new Map<string, Entry>();
  readonly #ipWindows = new Map<string, IpWindow>();
  readonly #policy: LockoutPolicy;
  readonly #now: () => number;

  constructor(policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY, now: () => number = Date.now) {
    this.#policy = policy;
    this.#now = now;
  }

  /** Remaining lock time in ms; 0 when the pair may try again. */
  retryAfterMs(username: string, ip: string): number {
    const key = pairKey(username, ip);
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    const now = this.#now();
    if (this.#isStale(entry, now)) {
      this.#entries.delete(key);
      return 0;
    }
    return Math.max(0, entry.lockedUntil - now);
  }

  /** Records a failed attempt; returns the lock it triggered (0 below the threshold). */
  recordFailure(username: string, ip: string): { lockedForMs: number } {
    const key = pairKey(username, ip);
    const now = this.#now();
    let entry = this.#entries.get(key);
    if (entry && this.#isStale(entry, now)) entry = undefined;
    const failures = (entry?.failures ?? 0) + 1;
    const { threshold, baseLockMs, maxLockMs } = this.#policy;
    const lockedForMs =
      failures >= threshold ? Math.min(baseLockMs * 2 ** (failures - threshold), maxLockMs) : 0;
    // Re-insert so iteration order stays "least recently failed first".
    this.#entries.delete(key);
    this.#entries.set(key, { failures, lockedUntil: now + lockedForMs, lastFailureAt: now });
    sweep(
      this.#entries,
      this.#policy.maxEntries,
      (e) => this.#isStale(e, now),
      (e) => now < e.lockedUntil,
    );
    return { lockedForMs };
  }

  recordSuccess(username: string, ip: string): void {
    this.#entries.delete(pairKey(username, ip));
  }

  /**
   * Spends one sign-in attempt from the IP's budget and returns 0; once the budget is spent,
   * returns the time in ms until its window ends and spends nothing.
   */
  takeIpAttempt(ip: string): number {
    const now = this.#now();
    const { ipAttempts, ipWindowMs } = this.#policy;
    let window = this.#ipWindows.get(ip);
    if (!window || this.#windowEnded(window, now)) {
      window = { startedAt: now, attempts: 0 };
      // Re-insert so iteration order stays "oldest window first".
      this.#ipWindows.delete(ip);
      this.#ipWindows.set(ip, window);
    } else if (window.attempts >= ipAttempts) {
      return window.startedAt + ipWindowMs - now;
    }
    window.attempts += 1;
    sweep(
      this.#ipWindows,
      this.#policy.maxEntries,
      (w) => this.#windowEnded(w, now),
      (w) => w.attempts >= ipAttempts,
    );
    return 0;
  }

  #isStale(entry: Entry, now: number): boolean {
    return now >= entry.lockedUntil && now - entry.lastFailureAt >= this.#policy.forgetAfterMs;
  }

  #windowEnded(window: IpWindow, now: number): boolean {
    return now - window.startedAt >= this.#policy.ipWindowMs;
  }
}

/**
 * Forgets stale entries at the front of `map` (oldest first). Over `maxEntries`, it then drops
 * stale entries anywhere, then the oldest entries that hold nothing (no running lock, budget not
 * spent), so flooding other keys cannot clear a running lock; only when every remaining entry
 * holds one does the oldest go (the memory bound wins).
 */
function sweep<V>(
  map: Map<string, V>,
  maxEntries: number,
  isStale: (value: V) => boolean,
  holds: (value: V) => boolean,
): void {
  for (const [key, value] of map) {
    if (!isStale(value)) break;
    map.delete(key);
  }
  if (map.size <= maxEntries) return;
  for (const [key, value] of map) if (isStale(value)) map.delete(key);
  for (const [key, value] of map) {
    if (map.size <= maxEntries) return;
    if (!holds(value)) map.delete(key);
  }
  for (const key of map.keys()) {
    if (map.size <= maxEntries) return;
    map.delete(key);
  }
}

/** Usernames are compared the way Better Auth's username plugin normalizes them (lowercase). */
function pairKey(username: string, ip: string): string {
  return JSON.stringify([username.trim().toLowerCase(), ip]);
}
