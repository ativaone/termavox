import '../server-guard.ts';

/**
 * Sign-in lockout per (username, client IP) with a progressive delay (plan §10.2, ADR-0004).
 * After `threshold` consecutive failures the pair is locked for `baseLockMs`, doubling with each
 * further failure up to `maxLockMs`. It is never a global account lock, so failures from one IP
 * cannot lock the account out from another.
 *
 * State lives in memory: the MVP runs a single web instance, and a restart clears the counters
 * (Better Auth's per-IP limiter and the argon2 cost still apply). Locked attempts are rejected
 * before the password is checked and do not extend the lock.
 */
export interface LockoutPolicy {
  threshold: number;
  baseLockMs: number;
  maxLockMs: number;
  /** A pair with no failure for this long (and no running lock) is forgotten. */
  forgetAfterMs: number;
  /** Bound on tracked pairs; the least recently failed pair is dropped first. */
  maxEntries: number;
}

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  threshold: 5,
  baseLockMs: 30_000,
  maxLockMs: 15 * 60_000,
  forgetAfterMs: 60 * 60_000,
  maxEntries: 10_000,
};

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

export class LoginLockout {
  readonly #entries = new Map<string, Entry>();
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
    this.#sweep(now);
    return { lockedForMs };
  }

  recordSuccess(username: string, ip: string): void {
    this.#entries.delete(pairKey(username, ip));
  }

  #isStale(entry: Entry, now: number): boolean {
    return now >= entry.lockedUntil && now - entry.lastFailureAt >= this.#policy.forgetAfterMs;
  }

  #sweep(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= this.#policy.maxEntries && !this.#isStale(entry, now)) break;
      this.#entries.delete(key);
    }
  }
}

/** Usernames are compared the way Better Auth's username plugin normalizes them (lowercase). */
function pairKey(username: string, ip: string): string {
  return JSON.stringify([username.trim().toLowerCase(), ip]);
}
