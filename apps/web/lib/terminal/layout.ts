import type { Dimensions } from './types.ts';

/** xterm's minimum terminal size (also what FitAddon.proposeDimensions clamps to). */
const MIN_COLS = 2;
const MIN_ROWS = 1;

export interface Size {
  width: number;
  height: number;
}

export interface LayoutInput {
  /** Inner size of the element the terminal is rendered in (CSS px). */
  container: Size;
  /** Size of one character cell (CSS px). */
  cell: Size;
  /** The session size the terminal renders (from the channel state); null before the snapshot. */
  session: Dimensions | null;
  /** The fitted viewport if already known (FitAddon.proposeDimensions()); computed otherwise. */
  viewport?: Dimensions | null;
  /** Horizontal space xterm reserves for its scrollbar (CSS px). */
  scrollbarWidth?: number;
}

export interface TerminalLayout {
  /** What to report with `setViewport`: the grid that fits the container. */
  viewport: Dimensions;
  /**
   * `fit`: the session size matches the container. `scale`: the session is larger, render it
   * scaled down by `scale`. `letterbox`: the session is smaller, render it at scale 1 with
   * empty space around it (plan §5.5, passive attachments).
   */
  mode: 'fit' | 'scale' | 'letterbox';
  /** CSS scale to apply to the terminal element (≤ 1). */
  scale: number;
  /** Unscaled size of the session grid (CSS px). */
  width: number;
  height: number;
  /** Offsets that would center the scaled grid in the container (CSS px). */
  offsetX: number;
  offsetY: number;
}

/** The grid that fits `container`, or null while the cell size is unknown (fonts not measured). */
export function fitViewport(container: Size, cell: Size, scrollbarWidth = 0): Dimensions | null {
  if (!(cell.width > 0 && cell.height > 0)) return null;
  return {
    cols: Math.max(
      MIN_COLS,
      Math.floor(Math.max(0, container.width - scrollbarWidth) / cell.width),
    ),
    rows: Math.max(MIN_ROWS, Math.floor(Math.max(0, container.height) / cell.height)),
  };
}

/**
 * Pure rendering-size helper: the viewport to report, and how to present a session whose size
 * differs from it. Active attachments converge to `fit` once the server applied their viewport;
 * passive ones keep the session size and get a scale (larger) or letterbox (smaller) suggestion.
 */
export function computeTerminalLayout(input: LayoutInput): TerminalLayout | null {
  const scrollbarWidth = input.scrollbarWidth ?? 0;
  const viewport = input.viewport ?? fitViewport(input.container, input.cell, scrollbarWidth);
  if (!viewport) return null;
  const grid = input.session ?? viewport;
  const width = grid.cols * input.cell.width + scrollbarWidth;
  const height = grid.rows * input.cell.height;
  const scale = Math.min(1, input.container.width / width, input.container.height / height);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const smaller = grid.cols < viewport.cols || grid.rows < viewport.rows;
  return {
    viewport,
    mode: safeScale < 1 ? 'scale' : smaller ? 'letterbox' : 'fit',
    scale: safeScale,
    width,
    height,
    offsetX: Math.max(0, (input.container.width - width * safeScale) / 2),
    offsetY: Math.max(0, (input.container.height - height * safeScale) / 2),
  };
}
