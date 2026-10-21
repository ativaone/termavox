import { describe, expect, it } from 'vitest';
import {
  AUTO_SCROLL_MAX,
  AUTO_SCROLL_ZONE,
  autoScrollStep,
  clampStart,
  landingIndex,
  type Slot,
  shiftOf,
} from '../../lib/workspace/tab-drag.ts';

/** Tabs laid out from 0 with a 4 px gap, as the strip draws them. */
function row(...sizes: number[]): Slot[] {
  let start = 0;
  return sizes.map((size) => {
    const slot = { start, size };
    start += size + 4;
    return slot;
  });
}

// Starts 0, 124, 228, 472; ends 120, 224, 468, 584.
const slots = row(120, 100, 240, 112);
const wide = { start: -1_000, end: 10_000 };

describe('tab drag: landing index', () => {
  it('stays in place until the leading edge passes a neighbour’s middle', () => {
    expect(landingIndex(slots, 1, 124)).toBe(1);
    // Dragged forward: its end (start + 100) against t2's middle (348).
    expect(landingIndex(slots, 1, 248)).toBe(1);
    expect(landingIndex(slots, 1, 249)).toBe(2);
    // …and t3's middle (528).
    expect(landingIndex(slots, 1, 429)).toBe(3);
    // Dragged back: its start against t0's middle (60).
    expect(landingIndex(slots, 1, 60)).toBe(1);
    expect(landingIndex(slots, 1, 59)).toBe(0);
  });

  it('passes several tabs at once and never leaves the row', () => {
    expect(landingIndex(slots, 3, 0)).toBe(0);
    expect(landingIndex(slots, 3, -500)).toBe(0);
    expect(landingIndex(slots, 0, 5_000)).toBe(3);
    expect(landingIndex(row(80), 0, 300)).toBe(0);
  });

  it('gives the same answer on the way back (no hysteresis, no flicker)', () => {
    const forward = [130, 200, 249, 300, 429].map((s) => landingIndex(slots, 1, s));
    const back = [429, 300, 249, 200, 130].map((s) => landingIndex(slots, 1, s)).reverse();
    expect(back).toEqual(forward);
  });
});

describe('tab drag: neighbours sliding aside', () => {
  it('slides the tabs between the two places by the dragged tab’s footprint', () => {
    // t1 (100 px + 4 px gap) dragged to index 3: t2 and t3 slide back by 104.
    expect([0, 1, 2, 3].map((i) => shiftOf(slots, 1, 3, i))).toEqual([0, 0, -104, -104]);
    // t2 (240 px) dragged to index 0: t0 and t1 slide forward by 244.
    expect([0, 1, 2, 3].map((i) => shiftOf(slots, 2, 0, i))).toEqual([244, 244, 0, 0]);
    expect([0, 1, 2, 3].map((i) => shiftOf(slots, 2, 2, i))).toEqual([0, 0, 0, 0]);
  });

  it('opens exactly the slot the tab lands in', () => {
    // After t1 lands at 3, t3 (slid back) ends 4 px before the dragged tab's new start.
    const t3End = slots[3]!.start + shiftOf(slots, 1, 3, 3) + slots[3]!.size;
    const landed = slots[3]!.start + slots[3]!.size - slots[1]!.size;
    expect(landed - t3End).toBe(4);
  });
});

describe('tab drag: clamping', () => {
  it('keeps the dragged tab within the row of tabs', () => {
    expect(clampStart(slots, 1, -80, wide)).toBe(0);
    expect(clampStart(slots, 1, 900, wide)).toBe(484); // 584 - 100
    expect(clampStart(slots, 1, 300, wide)).toBe(300);
  });

  it('keeps it within the visible part of a scrolled strip', () => {
    const view = { start: 200, end: 500 };
    expect(clampStart(slots, 1, 150, view)).toBe(200);
    expect(clampStart(slots, 1, 450, view)).toBe(400);
    // A strip narrower than the tab pins it to the visible start.
    expect(clampStart(slots, 2, 300, { start: 100, end: 200 })).toBe(100);
  });
});

describe('tab drag: auto-scroll near the edges', () => {
  const left = 100;
  const right = 700;

  it('scrolls back near the start, forward near the end, not in between', () => {
    expect(autoScrollStep(400, left, right)).toBe(0);
    expect(autoScrollStep(left + AUTO_SCROLL_ZONE, left, right)).toBe(0);
    expect(autoScrollStep(right - AUTO_SCROLL_ZONE, left, right)).toBe(0);
    expect(autoScrollStep(left + AUTO_SCROLL_ZONE - 1, left, right)).toBe(-1);
    expect(autoScrollStep(right - AUTO_SCROLL_ZONE + 1, left, right)).toBe(1);
  });

  it('is fastest at the edge and past it', () => {
    expect(autoScrollStep(left, left, right)).toBe(-AUTO_SCROLL_MAX);
    expect(autoScrollStep(left - 300, left, right)).toBe(-AUTO_SCROLL_MAX);
    expect(autoScrollStep(right, left, right)).toBe(AUTO_SCROLL_MAX);
    expect(autoScrollStep(right + 300, left, right)).toBe(AUTO_SCROLL_MAX);
    expect(autoScrollStep(left + AUTO_SCROLL_ZONE / 2, left, right)).toBe(
      -Math.round(AUTO_SCROLL_MAX / 2),
    );
  });

  it('shares a narrow strip between the two zones', () => {
    expect(autoScrollStep(130, 100, 160)).toBe(0);
    expect(autoScrollStep(129, 100, 160)).toBeLessThan(0);
    expect(autoScrollStep(131, 100, 160)).toBeGreaterThan(0);
    expect(autoScrollStep(100, 100, 100)).toBe(0);
  });
});
