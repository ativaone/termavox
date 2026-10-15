/** Reconnect backoff (plan §5.7): 1 s, 2 s, 4 s … capped at 60 s, with ±20 % jitter. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const BACKOFF_JITTER = 0.2;

/** Delay before reconnect attempt `failures + 1`; `random` returns a value in [0, 1). */
export function backoffDelay(failures: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures));
  return Math.round(base * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random()));
}
