import type { Dimensions } from '../core/types.ts';

/** Session size bounds (plan §5.5). */
export const MIN_SIZE: Readonly<Dimensions> = { cols: 20, rows: 5 };
export const MAX_SIZE: Readonly<Dimensions> = { cols: 500, rows: 200 };
export const RESIZE_DEBOUNCE_MS = 100;

export function clampSize({ cols, rows }: Dimensions): Dimensions {
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    cols: clamp(cols, MIN_SIZE.cols, MAX_SIZE.cols),
    rows: clamp(rows, MIN_SIZE.rows, MAX_SIZE.rows),
  };
}

export function sameSize(a: Dimensions, b: Dimensions): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

/**
 * Size policy (D-11, plan §5.5): the session follows the viewport of the active attachment, the
 * one that most recently sent input or took focus. The first attachment of a session without an
 * active one becomes active. Changes are debounced; `onChange` then reads `target()`/`active`.
 */
export class SizePolicy {
  readonly #viewports = new Map<string, Dimensions>();
  readonly #onChange: () => void;
  readonly #debounceMs: number;
  #active: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(onChange: () => void, debounceMs = RESIZE_DEBOUNCE_MS) {
    this.#onChange = onChange;
    this.#debounceMs = debounceMs;
  }

  get active(): string | null {
    return this.#active;
  }

  /** The clamped viewport of the active attachment, or null when there is none. */
  target(): Dimensions | null {
    const viewport = this.#active ? this.#viewports.get(this.#active) : undefined;
    return viewport ? clampSize(viewport) : null;
  }

  add(id: string, viewport: Dimensions): void {
    this.#viewports.set(id, viewport);
    if (this.#active === null) {
      this.#active = id;
      this.#schedule();
    }
  }

  /** The active attachment leaving keeps the current size until another one takes over. */
  remove(id: string): void {
    this.#viewports.delete(id);
    if (this.#active === id) this.#active = null;
  }

  viewport(id: string, viewport: Dimensions): void {
    if (!this.#viewports.has(id)) return;
    this.#viewports.set(id, viewport);
    if (this.#active === id) this.#schedule();
  }

  activate(id: string): void {
    if (!this.#viewports.has(id) || this.#active === id) return;
    this.#active = id;
    this.#schedule();
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#onChange();
    }, this.#debounceMs);
  }
}
