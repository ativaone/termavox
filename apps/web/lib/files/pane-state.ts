/**
 * The file panel's state per pane (plan §5.12): open or not, its width, the folder on screen and
 * the hidden-files toggle. It lives in the browser tab's memory only: nothing is persisted and
 * nothing joins the saved layout. A pane that shows another session starts over. Framework-free
 * (the `useSyncExternalStore` shape).
 */

/** Width a panel opens at, the narrowest it gets, and what a docked panel leaves the terminal. */
export const PANEL_DEFAULT_WIDTH = 380;
export const PANEL_MIN_WIDTH = 300;
export const TERMINAL_MIN_WIDTH = 320;
/** The draggable gap between the terminal and a docked panel. */
export const PANEL_DIVIDER_WIDTH = 8;

export interface PaneFilesState {
  /** The session the state belongs to: a pane bound to another session starts over. */
  sessionId: string;
  open: boolean;
  width: number;
  /** The folder on screen; null until the panel has opened once. */
  path: string | null;
  showHidden: boolean;
}

export function closedState(sessionId: string): PaneFilesState {
  return { sessionId, open: false, width: PANEL_DEFAULT_WIDTH, path: null, showHidden: false };
}

export class PaneFilesStore {
  readonly #states = new Map<string, PaneFilesState>();
  readonly #listeners = new Set<() => void>();

  /** The pane's state for `sessionId`, or null when it has none (closed, nothing remembered). */
  get(paneId: string, sessionId: string): PaneFilesState | null {
    const state = this.#states.get(paneId);
    return state && state.sessionId === sessionId ? state : null;
  }

  update(
    paneId: string,
    sessionId: string,
    patch: Partial<Omit<PaneFilesState, 'sessionId'>>,
  ): void {
    const current = this.get(paneId, sessionId) ?? closedState(sessionId);
    const next = { ...current, ...patch };
    if (
      next.open === current.open &&
      next.width === current.width &&
      next.path === current.path &&
      next.showHidden === current.showHidden &&
      this.#states.get(paneId) === current
    ) {
      return;
    }
    this.#states.set(paneId, next);
    for (const listener of [...this.#listeners]) listener();
  }

  toggle(paneId: string, sessionId: string): void {
    const open = this.get(paneId, sessionId)?.open ?? false;
    this.update(paneId, sessionId, { open: !open });
  }

  /** Forgets panes that are gone (closed panes, closed tabs). */
  retain(paneIds: ReadonlySet<string>): void {
    let changed = false;
    for (const paneId of this.#states.keys()) {
      if (!paneIds.has(paneId)) {
        this.#states.delete(paneId);
        changed = true;
      }
    }
    if (changed) for (const listener of [...this.#listeners]) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

export interface PanelGeometry {
  /** `dock`: beside the terminal, which shrinks. `cover`: over the terminal, which keeps its size. */
  mode: 'dock' | 'cover';
  /** The panel's width in CSS px (the whole pane when it covers). */
  width: number;
  /** The widest a docked panel may get in this pane. */
  max: number;
}

/**
 * Where the panel goes in a pane `paneWidth` px wide: docked at the requested width (kept between
 * 300 px and what leaves the terminal 320 px), or over the terminal when even the narrowest panel
 * would leave it less than 320 px.
 */
export function panelGeometry(paneWidth: number, requested: number): PanelGeometry {
  const max = paneWidth - TERMINAL_MIN_WIDTH - PANEL_DIVIDER_WIDTH;
  if (max < PANEL_MIN_WIDTH) {
    return { mode: 'cover', width: Math.max(0, paneWidth), max: PANEL_MIN_WIDTH };
  }
  return {
    mode: 'dock',
    width: Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, requested))),
    max,
  };
}
