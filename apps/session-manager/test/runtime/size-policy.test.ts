import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampSize, SizePolicy } from '../../src/attachments/size-policy.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('size policy', () => {
  it('follows the active attachment, debounced 100 ms, ignoring passive viewports', () => {
    const changes: Array<{ active: string | null; target: unknown }> = [];
    const policy: SizePolicy = new SizePolicy(() =>
      changes.push({ active: policy.active, target: policy.target() }),
    );
    policy.add('a', { cols: 100, rows: 30 }); // first attachment becomes active
    policy.add('b', { cols: 80, rows: 24 });
    vi.advanceTimersByTime(99);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([{ active: 'a', target: { cols: 100, rows: 30 } }]);

    policy.viewport('b', { cols: 90, rows: 20 }); // passive: no resize
    policy.viewport('a', { cols: 110, rows: 30 });
    vi.advanceTimersByTime(50);
    policy.viewport('a', { cols: 120, rows: 40 }); // restarts the debounce
    vi.advanceTimersByTime(99);
    expect(changes).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(changes.at(-1)).toEqual({ active: 'a', target: { cols: 120, rows: 40 } });

    policy.activate('b'); // input or focus makes b active
    vi.advanceTimersByTime(100);
    expect(changes.at(-1)).toEqual({ active: 'b', target: { cols: 90, rows: 20 } });

    policy.remove('b'); // the size stays until someone else takes over
    expect(policy.active).toBeNull();
    expect(policy.target()).toBeNull();
    vi.advanceTimersByTime(100);
    expect(changes).toHaveLength(3);
  });

  it('clamps the session size to 20×5 … 500×200', () => {
    expect(clampSize({ cols: 3, rows: 1 })).toEqual({ cols: 20, rows: 5 });
    expect(clampSize({ cols: 900, rows: 400 })).toEqual({ cols: 500, rows: 200 });
    expect(clampSize({ cols: 132, rows: 43 })).toEqual({ cols: 132, rows: 43 });
  });
});
