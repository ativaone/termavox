import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay } from '../../src/core/backoff.ts';
import { TransportError } from '../../src/core/types.ts';
import { harness } from './fakes.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('reconnect backoff', () => {
  it('waits 1, 2, 4 … 60 s between attempts, and retry() skips the wait', async () => {
    vi.useFakeTimers({ now: 0 });
    const h = harness({
      behavior: () => ({
        connect: async () => {
          throw new TransportError('HOST_UNREACHABLE', 'down', true);
        },
      }),
    });
    const rt = h.runtime({ random: () => 0.5 }); // no jitter
    void rt.start();
    await vi.advanceTimersByTimeAsync(183_000);
    expect(h.factory.times).toEqual([
      0, 1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 123_000, 183_000,
    ]);
    expect(rt.state).toBe('reconnecting');
    expect(h.notifier.ofType('session.status').at(-1)?.retryInMs).toBe(60_000);

    await rt.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.factory.times.at(-1)).toBe(183_000);
    expect(h.factory.times).toHaveLength(10);
    await rt.shutdown();
  });

  it('applies ±20 % jitter around the capped base', () => {
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(0, () => 0.999_999)).toBe(1_200);
    expect(backoffDelay(3, () => 0.5)).toBe(8_000);
    expect(backoffDelay(20, () => 0)).toBe(48_000);
    expect(backoffDelay(20, () => 0.999_999)).toBe(72_000);
  });
});
