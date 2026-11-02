import type { NoteMeta } from './types.ts';

/**
 * What a pane shows of its session's notes (plan D-58): the terminal or a note, the last note it
 * viewed, and the small transient states that the caption's tabs and the note view share (the
 * rename field, the delete slip, the notice). It lives in the browser tab's memory only, like
 * `PaneFilesStore`: nothing joins the saved layout, and a pane bound to another session starts
 * over. Framework-free (the `useSyncExternalStore` shape).
 */

/** What the note view says about the pane's own actions (the note's save state has its own). */
export type PaneNotice =
  | 'titleInvalid'
  | 'limit'
  | 'createFailed'
  | 'deleteFailed'
  | 'signIn'
  | 'copyFailed';

export interface PaneNotesState {
  /** The session the state belongs to. */
  sessionId: string;
  /** The notes view covers the terminal. */
  on: boolean;
  /** The note on screen, or the last one viewed; null when none has been yet. */
  noteId: string | null;
  /** The note whose tab shows the rename field. */
  renaming: string | null;
  /** The note whose delete slip is showing. */
  deleting: string | null;
  notice: PaneNotice | null;
  /** Bumped when the text should take the keyboard, so a view that waits re-checks. */
  focusSeq: number;
}

/** Where the caret and the scroll were, so going back to a note carries on from there. */
export interface NoteCaret {
  start: number;
  end: number;
  scrollTop: number;
}

function initial(sessionId: string): PaneNotesState {
  return {
    sessionId,
    on: false,
    noteId: null,
    renaming: null,
    deleting: null,
    notice: null,
    focusSeq: 0,
  };
}

/** The note a pane shows: the one it remembers if it still exists, otherwise the first. */
export function shownNoteId(
  notes: readonly Pick<NoteMeta, 'id'>[],
  remembered: string | null | undefined,
): string | null {
  if (remembered && notes.some((note) => note.id === remembered)) return remembered;
  return notes[0]?.id ?? null;
}

export class PaneNotesStore {
  readonly #states = new Map<string, PaneNotesState>();
  readonly #wantsFocus = new Set<string>();
  readonly #carets = new Map<string, Map<string, NoteCaret>>();
  readonly #listeners = new Set<() => void>();

  /** The pane's state for `sessionId`; null when it has none (terminal, nothing remembered). */
  get(paneId: string, sessionId: string): PaneNotesState | null {
    const state = this.#states.get(paneId);
    return state && state.sessionId === sessionId ? state : null;
  }

  /** The notes view covers this pane's terminal. */
  isOn(paneId: string, sessionId: string): boolean {
    return this.get(paneId, sessionId)?.on ?? false;
  }

  /**
   * Shows a note (null: the first there is, or the empty view). The text takes the keyboard
   * unless the rename field does, or `focus` is false.
   */
  showNote(
    paneId: string,
    sessionId: string,
    noteId: string | null,
    options: { rename?: boolean; focus?: boolean } = {},
  ): void {
    const { rename = false, focus = !rename } = options;
    const current = this.get(paneId, sessionId);
    this.#set(paneId, sessionId, {
      on: true,
      noteId: noteId ?? current?.noteId ?? null,
      renaming: rename ? noteId : null,
      deleting: null,
      notice: null,
    });
    if (focus) this.requestTextFocus(paneId, sessionId);
  }

  showTerminal(paneId: string, sessionId: string): void {
    if (!this.isOn(paneId, sessionId)) return;
    this.#wantsFocus.delete(paneId);
    this.#set(paneId, sessionId, { on: false, renaming: null, deleting: null, notice: null });
  }

  /** Toggles between the terminal and the last note viewed; returns whether a note is on now. */
  toggle(paneId: string, sessionId: string): boolean {
    if (this.isOn(paneId, sessionId)) {
      this.showTerminal(paneId, sessionId);
      return false;
    }
    this.showNote(paneId, sessionId, null);
    return true;
  }

  /** Remembers which note the pane resolved to, without telling anyone. */
  remember(paneId: string, sessionId: string, noteId: string): void {
    const state = this.get(paneId, sessionId);
    if (state && state.noteId !== noteId) this.#states.set(paneId, { ...state, noteId });
  }

  startRename(paneId: string, sessionId: string, noteId: string): void {
    this.#set(paneId, sessionId, { on: true, noteId, renaming: noteId, deleting: null });
  }

  /** Closes the rename field; `focusText` hands the keyboard to the note (Enter, Escape). */
  stopRename(paneId: string, sessionId: string, focusText: boolean): void {
    if (!this.get(paneId, sessionId)?.renaming) return;
    this.#set(paneId, sessionId, { renaming: null });
    if (focusText) this.requestTextFocus(paneId, sessionId);
  }

  /** Selects the note and shows its delete slip, which takes the keyboard itself. */
  askDelete(paneId: string, sessionId: string, noteId: string): void {
    this.#wantsFocus.delete(paneId);
    this.#set(paneId, sessionId, { on: true, noteId, deleting: noteId, renaming: null });
  }

  cancelDelete(paneId: string, sessionId: string): void {
    this.#set(paneId, sessionId, { deleting: null });
    this.requestTextFocus(paneId, sessionId);
  }

  /** Says something in the note view, bringing the view up if the terminal is on screen. */
  setNotice(paneId: string, sessionId: string, notice: PaneNotice | null): void {
    this.#set(paneId, sessionId, notice ? { on: true, notice } : { notice });
  }

  requestTextFocus(paneId: string, sessionId: string): void {
    const state = this.get(paneId, sessionId);
    if (!state) return;
    this.#wantsFocus.add(paneId);
    this.#set(paneId, sessionId, { focusSeq: state.focusSeq + 1 });
  }

  /** True once per request: the view that takes the keyboard consumes it. */
  takeTextFocus(paneId: string): boolean {
    return this.#wantsFocus.delete(paneId);
  }

  caret(paneId: string, noteId: string): NoteCaret | undefined {
    return this.#carets.get(paneId)?.get(noteId);
  }

  saveCaret(paneId: string, noteId: string, caret: NoteCaret): void {
    let carets = this.#carets.get(paneId);
    if (!carets) {
      carets = new Map();
      this.#carets.set(paneId, carets);
    }
    carets.set(noteId, caret);
  }

  /** Forgets panes that are gone (closed panes, closed tabs). */
  retain(paneIds: ReadonlySet<string>): void {
    let changed = false;
    for (const paneId of this.#states.keys()) {
      if (!paneIds.has(paneId)) {
        this.#states.delete(paneId);
        this.#carets.delete(paneId);
        this.#wantsFocus.delete(paneId);
        changed = true;
      }
    }
    if (changed) this.#emit();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #set(paneId: string, sessionId: string, patch: Partial<Omit<PaneNotesState, 'sessionId'>>): void {
    const current = this.get(paneId, sessionId);
    if (!current) {
      // Another session in this pane starts over.
      this.#carets.delete(paneId);
      this.#wantsFocus.delete(paneId);
    }
    this.#states.set(paneId, { ...(current ?? initial(sessionId)), ...patch });
    this.#emit();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
