/**
 * Reordering tabs by dragging them along the tab row: pure geometry over where every tab rests
 * in the strip, in the strip's content coordinates (px from the start of its scrollable content,
 * so scrolling the strip never moves a slot). The dragged tab lands where its leading edge has
 * passed the middle of the neighbours it was dragged over; those neighbours slide aside by its
 * own footprint to open that slot.
 */

/** Where a tab rests in the strip: its start and width, in px. */
export interface Slot {
  start: number;
  size: number;
}

/** Horizontal pointer travel (px) before a press on a tab becomes a drag; below it, a click. */
export const DRAG_THRESHOLD = 5;
/** Width (px) of the band along each end of the strip where a drag scrolls it. */
export const AUTO_SCROLL_ZONE = 32;
/** The auto-scroll speed at the very edge (px per frame); it eases to 1 at the band's inner side. */
export const AUTO_SCROLL_MAX = 12;

const end = (slot: Slot): number => slot.start + slot.size;

/**
 * Where the dragged tab (at `from`) is drawn for a wanted start: inside the row's tabs and inside
 * the visible part of the strip (`view`), so it never slides under an edge or past the last tab.
 */
export function clampStart(
  slots: readonly Slot[],
  from: number,
  wanted: number,
  view: { start: number; end: number },
): number {
  const own = slots[from]!;
  const lower = Math.max(slots[0]!.start, view.start);
  const upper = Math.min(end(slots[slots.length - 1]!), view.end) - own.size;
  if (upper < lower) return lower;
  return Math.min(upper, Math.max(lower, wanted));
}

/**
 * The index the tab dragged from `from` lands at when drawn at `start`: dragged forward, it
 * passes each following tab once its end crosses that tab's middle; dragged back, each previous
 * tab once its start does.
 */
export function landingIndex(slots: readonly Slot[], from: number, start: number): number {
  const own = slots[from]!;
  let to = from;
  if (start > own.start) {
    const lead = start + own.size;
    while (to + 1 < slots.length && lead > slots[to + 1]!.start + slots[to + 1]!.size / 2) to++;
  } else if (start < own.start) {
    while (to - 1 >= 0 && start < slots[to - 1]!.start + slots[to - 1]!.size / 2) to--;
  }
  return to;
}

/**
 * How far (px, negative towards the start) the tab at `index` slides aside while the tab dragged
 * from `from` would land at `to`: by the dragged tab's footprint (its width and the gap after it)
 * for every tab between the two places, not at all for the others.
 */
export function shiftOf(slots: readonly Slot[], from: number, to: number, index: number): number {
  if (from < to && index > from && index <= to) {
    return slots[from]!.start - slots[from + 1]!.start;
  }
  if (to < from && index >= to && index < from) {
    return end(slots[from]!) - end(slots[from - 1]!);
  }
  return 0;
}

/**
 * The auto-scroll step (px per frame) for a pointer at `x` over a strip drawn from `left` to
 * `right`: negative within the zone at the start, positive within the zone at the end (and past
 * either edge), faster nearer the edge; 0 elsewhere.
 */
export function autoScrollStep(x: number, left: number, right: number): number {
  const zone = Math.min(AUTO_SCROLL_ZONE, (right - left) / 2);
  if (zone <= 0) return 0;
  const speed = (depth: number) =>
    Math.max(1, Math.round(AUTO_SCROLL_MAX * Math.min(1, depth / zone)));
  if (x < left + zone) return -speed(left + zone - x);
  if (x > right - zone) return speed(x - (right - zone));
  return 0;
}
