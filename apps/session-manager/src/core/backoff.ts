/**
 * Connect retry policy (plan §5.7, D-31), with ±20 % jitter on every wait.
 *
 * - A session that never connected: 4 attempts in all, at once and then after 5 s, 15 s and 30 s.
 * - A session that lost its connection: after 2 s, 5 s, 10 s, 30 s and then every 60 s, as long as
 *   the attempt starts within 30 minutes of the loss.
 *
 * Past either limit the session waits for the user (Retry or End).
 */
export const FIRST_CONNECT_DELAYS_MS = [5_000, 15_000, 30_000] as const;
export const FIRST_CONNECT_ATTEMPTS = FIRST_CONNECT_DELAYS_MS.length + 1;
export const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;
export const BACKOFF_MAX_MS = 60_000;
export const RECONNECT_WINDOW_MS = 30 * 60_000;
export const BACKOFF_JITTER = 0.2;

export type RetryRound =
  /** A session that never connected: attempt 1 runs at once. */
  | { kind: 'first' }
  /** A session that lost its connection (or was connected before a daemon restart) at `since`. */
  | { kind: 'reconnect'; since: number };

export interface RetryStep {
  delayMs: number;
  /** First round: the attempt that runs after the wait, of `maxAttempts`. */
  attempt?: number;
  maxAttempts?: number;
  /** Reconnect round: no attempt starts after this instant (epoch ms). */
  retryUntil?: number;
}

/**
 * The wait before the next attempt of a round, or null once the round is over. `waits` = how
 * many waits the round already had (0 before the first one).
 */
export function nextRetry(
  round: RetryRound,
  waits: number,
  now: number,
  random: () => number = Math.random,
): RetryStep | null {
  if (round.kind === 'first') {
    const base = FIRST_CONNECT_DELAYS_MS[waits];
    if (base === undefined) return null;
    return {
      delayMs: jitter(base, random),
      attempt: waits + 2,
      maxAttempts: FIRST_CONNECT_ATTEMPTS,
    };
  }
  const retryUntil = round.since + RECONNECT_WINDOW_MS;
  const delayMs = jitter(RECONNECT_DELAYS_MS[waits] ?? BACKOFF_MAX_MS, random);
  if (now + delayMs > retryUntil) return null;
  return { delayMs, retryUntil };
}

function jitter(base: number, random: () => number): number {
  return Math.round(base * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random()));
}
