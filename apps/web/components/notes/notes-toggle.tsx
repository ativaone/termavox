'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { lowestFreeNoteTitle } from '../../lib/notes/naming.ts';
import type { PaneNotesState } from '../../lib/notes/pane-view.ts';
import type { NoteState, SessionNotes } from '../../lib/notes/store.ts';
import { PANE_TOOL_CLASSES } from '../files/files-toggle.tsx';
import { NoteIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { useWorkspace, type WorkspaceContextValue } from '../workspace/workspace-context.tsx';

type NotesContext = Pick<WorkspaceContextValue, 'notes' | 'paneNotes' | 'focusPane' | 'isDesktop'>;

/** What a pane shows of its session's notes (null: the terminal, nothing remembered). */
export function usePaneNotes(paneId: string, sessionId: string | null): PaneNotesState | null {
  const { paneNotes } = useWorkspace();
  const read = useCallback(
    () => (sessionId ? paneNotes.get(paneId, sessionId) : null),
    [paneNotes, paneId, sessionId],
  );
  return useSyncExternalStore(paneNotes.subscribe, read, read);
}

export function useNoteCount(sessionId: string | null): number {
  const { notes } = useWorkspace();
  const read = () => (sessionId ? (notes.getCounts()[sessionId] ?? 0) : 0);
  return useSyncExternalStore(notes.subscribe, read, read);
}

export function useSessionNotes(sessionId: string): SessionNotes {
  const { notes } = useWorkspace();
  const read = useCallback(() => notes.getSession(sessionId), [notes, sessionId]);
  return useSyncExternalStore(notes.subscribe, read, read);
}

export function useNote(sessionId: string, noteId: string): NoteState | null {
  const { notes } = useWorkspace();
  const read = useCallback(() => notes.getNote(sessionId, noteId), [notes, sessionId, noteId]);
  return useSyncExternalStore(notes.subscribe, read, read);
}

/** Back to the terminal, which takes the keyboard (a phone's stays down until it is asked for). */
export function goToTerminal(ws: NotesContext, paneId: string, sessionId: string): void {
  ws.notes.flush(sessionId);
  ws.paneNotes.showTerminal(paneId, sessionId);
  if (ws.isDesktop) ws.focusPane(paneId);
}

/** Shows a note (null: the last one viewed, the first, or the empty view). */
export function openNote(
  ws: NotesContext,
  paneId: string,
  sessionId: string,
  noteId: string | null,
): void {
  ws.notes.flush(sessionId);
  ws.notes.ensureList(sessionId);
  // A phone's soft keyboard would cover the note being read: it comes up on a tap in the text.
  ws.paneNotes.showNote(paneId, sessionId, noteId, { focus: ws.isDesktop });
}

/** Terminal ⇄ the last note viewed: the Notes button and Ctrl+Shift+L. */
export function togglePaneNotes(ws: NotesContext, paneId: string, sessionId: string): void {
  if (ws.paneNotes.isOn(paneId, sessionId)) goToTerminal(ws, paneId, sessionId);
  else openNote(ws, paneId, sessionId, null);
}

/** A new note, named by the catalog, opened with its rename field active. */
export async function createNote(
  ws: NotesContext,
  paneId: string,
  sessionId: string,
  format: (n: number) => string,
): Promise<void> {
  ws.notes.flush(sessionId);
  const titles = ws.notes.getSession(sessionId).notes.map((note) => note.title);
  const result = await ws.notes.create(sessionId, lowestFreeNoteTitle(titles, format));
  if (result.ok) {
    ws.paneNotes.showNote(paneId, sessionId, result.id, { rename: true });
    return;
  }
  const notice =
    result.reason === 'limit' ? 'limit' : result.reason === 'signIn' ? 'signIn' : 'createFailed';
  ws.paneNotes.setNotice(paneId, sessionId, notice);
}

/** Deletes a note; the neighbouring tab takes over if it was on screen. */
export async function deleteNote(
  ws: NotesContext,
  paneId: string,
  sessionId: string,
  noteId: string,
): Promise<void> {
  const before = ws.notes.getSession(sessionId).notes;
  const index = before.findIndex((note) => note.id === noteId);
  const next = before[index + 1]?.id ?? before[index - 1]?.id ?? null;
  const result = await ws.notes.remove(sessionId, noteId);
  if (!result.ok) {
    // It changed elsewhere, or was not as empty as it looked: the user decides, seeing it.
    if (result.reason === 'stale') {
      ws.paneNotes.askDelete(paneId, sessionId, noteId);
      return;
    }
    const notice = result.reason === 'signIn' ? 'signIn' : 'deleteFailed';
    ws.paneNotes.setNotice(paneId, sessionId, notice);
    return;
  }
  const state = ws.paneNotes.get(paneId, sessionId);
  if (!state?.on) {
    // Its × had the keyboard and is gone.
    if (ws.isDesktop) ws.focusPane(paneId);
  } else if (state.noteId === noteId) {
    ws.paneNotes.showNote(paneId, sessionId, next, { focus: ws.isDesktop });
  } else if (ws.isDesktop) {
    ws.paneNotes.requestTextFocus(paneId, sessionId);
  }
}

/** A note's ×: an empty one goes at once, one with text asks first, on screen. */
export function requestDeleteNote(
  ws: NotesContext,
  paneId: string,
  sessionId: string,
  noteId: string,
): void {
  if (ws.notes.isEmpty(sessionId, noteId)) void deleteNote(ws, paneId, sessionId, noteId);
  else ws.paneNotes.askDelete(paneId, sessionId, noteId);
}

/** The Notes toggle in a desktop pane's caption: every bound session has it, whatever its state. */
export function NotesPaneButton({
  paneId,
  sessionId,
  label,
}: {
  paneId: string;
  sessionId: string;
  label: string;
}) {
  const t = useTranslations('notes');
  const ws = useWorkspace();
  const { notes } = ws;
  const count = useNoteCount(sessionId);
  const on = usePaneNotes(paneId, sessionId)?.on ?? false;
  useEffect(() => notes.ensureList(sessionId), [notes, sessionId]);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => togglePaneNotes(ws, paneId, sessionId)}
      aria-label={t('toggleLabel', { label, count })}
      aria-keyshortcuts="Control+Shift+L Meta+Shift+L"
      title={t('toggle')}
      className={cx(PANE_TOOL_CLASSES, 'relative')}
    >
      <NoteIcon size={16} className={on ? 'text-accent' : undefined} />
      <span className="@max-[24rem]:sr-only">{t('toggle')}</span>
      {count > 0 ? (
        // In the folded control the count rides on the glyph's corner.
        <span
          aria-hidden="true"
          className="rounded-pill bg-ground px-1.5 font-data font-medium text-2xs text-ink-muted leading-4 @max-[24rem]:absolute @max-[24rem]:-end-1 @max-[24rem]:-top-1 @max-[24rem]:px-1 @max-[24rem]:leading-3.5"
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** The phone pane header's Notes button: switches to the full-screen notes view. */
export function NotesPhoneButton({
  paneId,
  sessionId,
  label,
}: {
  paneId: string;
  sessionId: string;
  label: string;
}) {
  const t = useTranslations('notes');
  const ws = useWorkspace();
  const { notes } = ws;
  const count = useNoteCount(sessionId);
  useEffect(() => notes.ensureList(sessionId), [notes, sessionId]);
  return (
    <Button
      variant="quiet"
      size="lg"
      iconOnly
      onClick={() => togglePaneNotes(ws, paneId, sessionId)}
      aria-label={t('toggleLabel', { label, count })}
      title={t('toggle')}
      icon={<NoteIcon size={20} />}
      className="relative"
    >
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="absolute end-1 top-1 rounded-pill bg-ground px-1 font-data font-medium text-2xs text-ink-muted leading-3.5"
        >
          {count}
        </span>
      ) : null}
    </Button>
  );
}
