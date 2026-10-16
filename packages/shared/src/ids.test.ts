import { describe, expect, it } from 'vitest';
import { createUuidv7, randomToken, uuidv7 } from './ids.ts';

const FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = (id: string): string => id.replace(/-/g, '');
/** The 48-bit unix-ms timestamp of a UUIDv7. */
const timeOf = (id: string): number => Number.parseInt(hex(id).slice(0, 12), 16);
/** The 12-bit counter in `rand_a`. */
const counterOf = (id: string): number => Number.parseInt(hex(id).slice(13, 16), 16);

function expectStrictlyIncreasing(ids: string[]): void {
  for (let i = 1; i < ids.length; i++) {
    if (!(ids[i - 1]! < ids[i]!)) {
      throw new Error(`ids[${i - 1}] = ${ids[i - 1]} is not below ids[${i}] = ${ids[i]}`);
    }
  }
}

describe('uuidv7', () => {
  it('encodes version, variant and the timestamp', () => {
    const next = createUuidv7();
    const a = next(1_700_000_000_000);
    const b = next(1_700_000_000_001);
    expect(a).toMatch(FORMAT);
    expect(b).toMatch(FORMAT);
    expect(a < b).toBe(true);
    expect(timeOf(a)).toBe(1_700_000_000_000);
    expect(timeOf(b)).toBe(1_700_000_000_001);
  });

  it('keeps ids made in the same millisecond in creation order (RFC 9562 §6.2 counter)', () => {
    const next = createUuidv7();
    const ids = Array.from({ length: 1_000 }, () => next(1_700_000_000_000));
    expectStrictlyIncreasing(ids);
    for (const id of ids) expect(id).toMatch(FORMAT);
    // A counter seeded with its top bit clear has room for at least 2048 ids per millisecond.
    expect(counterOf(ids[0]!)).toBeLessThan(0x800);
    expect(new Set(ids.map(timeOf))).toEqual(new Set([1_700_000_000_000]));
  });

  it('re-seeds the counter each new millisecond', () => {
    const seeds = new Set<number>();
    const next = createUuidv7();
    for (let ms = 0; ms < 64; ms++) {
      const id = next(1_700_000_000_000 + ms);
      expect(timeOf(id)).toBe(1_700_000_000_000 + ms);
      seeds.add(counterOf(id));
    }
    expect(seeds.size).toBeGreaterThan(1); // random seeds, not a counter carried across ms
  });

  it('borrows the next millisecond when the counter is full', () => {
    // Every random byte 0xff: the counter seeds at 0x7ff, the highest seed.
    const next = createUuidv7((size) => Buffer.alloc(size, 0xff));
    const t = 1_700_000_000_000;
    const ids = Array.from({ length: 0x800 + 2 }, () => next(t));
    expectStrictlyIncreasing(ids);
    expect(counterOf(ids[0]!)).toBe(0x7ff);
    expect(counterOf(ids[0x800]!)).toBe(0xfff); // 2048 increments later: full
    expect(timeOf(ids[0x800]!)).toBe(t);
    expect(timeOf(ids[0x801]!)).toBe(t + 1); // borrowed, re-seeded
    expect(counterOf(ids[0x801]!)).toBe(0x7ff);
    // The real clock catching up continues after the borrowed millisecond, in order.
    const later = [next(t + 1), next(t + 2)];
    expectStrictlyIncreasing([...ids, ...later]);
    expect(timeOf(later[0]!)).toBe(t + 1);
    expect(timeOf(later[1]!)).toBe(t + 2);
  });

  it('stays in order when a caller passes an earlier time', () => {
    const next = createUuidv7();
    const first = next(1_700_000_000_500);
    const earlier = next(1_700_000_000_000);
    const same = next(1_700_000_000_500);
    expectStrictlyIncreasing([first, earlier, same]);
    // The embedded time never goes backwards: it may be later than `now`, never earlier.
    expect(timeOf(earlier)).toBe(1_700_000_000_500);
    expect(timeOf(same)).toBe(1_700_000_000_500);
  });

  it('rejects timestamps it cannot encode', () => {
    const next = createUuidv7();
    for (const bad of [Number.NaN, -1, 2 ** 48, Number.POSITIVE_INFINITY]) {
      expect(() => next(bad)).toThrow(RangeError);
    }
  });

  it('is monotonic across the process-wide generator', () => {
    const ids = Array.from({ length: 2_000 }, () => uuidv7());
    expectStrictlyIncreasing(ids);
    const at = Date.now();
    const pinned = [uuidv7(at), uuidv7(at), uuidv7(at)];
    expectStrictlyIncreasing([...ids, ...pinned]);
  });
});

describe('randomToken', () => {
  it('only uses tmux-safe characters', () => {
    expect(randomToken(64)).toMatch(/^[a-z2-7]{64}$/);
  });
});
