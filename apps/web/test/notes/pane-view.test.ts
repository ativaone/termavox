import { describe, expect, it, vi } from 'vitest';
import { PaneNotesStore, shownNoteId } from '../../lib/notes/pane-view.ts';

describe('which tab a pane shows (plan D-58)', () => {
  it('starts on the terminal, with nothing remembered', () => {
    const panes = new PaneNotesStore();
    expect(panes.get('p', 's')).toBeNull();
    expect(panes.isOn('p', 's')).toBe(false);
  });

  it('toggles between the terminal and the last note viewed', () => {
    const panes = new PaneNotesStore();
    expect(panes.toggle('p', 's')).toBe(true);
    expect(panes.get('p', 's')).toMatchObject({ on: true, noteId: null });
    panes.showNote('p', 's', 'n2');
    expect(panes.toggle('p', 's')).toBe(false);
    expect(panes.isOn('p', 's')).toBe(false);
    expect(panes.toggle('p', 's')).toBe(true);
    expect(panes.get('p', 's')!.noteId).toBe('n2');
  });

  it('a pane bound to another session starts over', () => {
    const panes = new PaneNotesStore();
    panes.showNote('p', 's', 'n1');
    panes.saveCaret('p', 'n1', { start: 1, end: 1, scrollTop: 0 });
    expect(panes.get('p', 'other')).toBeNull();
    expect(panes.isOn('p', 'other')).toBe(false);
    panes.showNote('p', 'other', null);
    expect(panes.get('p', 'other')).toMatchObject({ noteId: null, on: true });
    expect(panes.caret('p', 'n1')).toBeUndefined();
    // Coming back: the first session's state went with it.
    expect(panes.get('p', 's')).toBeNull();
  });

  it('resolves the note on screen: the remembered one, or the first', () => {
    const notes = [{ id: 'a' }, { id: 'b' }];
    expect(shownNoteId(notes, 'b')).toBe('b');
    expect(shownNoteId(notes, 'gone')).toBe('a');
    expect(shownNoteId(notes, null)).toBe('a');
    expect(shownNoteId([], 'a')).toBeNull();
  });

  it('asks for the keyboard once per request, except for the rename field', () => {
    const panes = new PaneNotesStore();
    panes.showNote('p', 's', 'n1');
    expect(panes.takeTextFocus('p')).toBe(true);
    expect(panes.takeTextFocus('p')).toBe(false);
    panes.showNote('p', 's', 'n2', { rename: true });
    expect(panes.get('p', 's')!.renaming).toBe('n2');
    expect(panes.takeTextFocus('p')).toBe(false);
    panes.stopRename('p', 's', true);
    expect(panes.get('p', 's')!.renaming).toBeNull();
    expect(panes.takeTextFocus('p')).toBe(true);
    panes.startRename('p', 's', 'n2');
    panes.stopRename('p', 's', false);
    expect(panes.takeTextFocus('p')).toBe(false);
  });

  it('going to the terminal drops a pending focus, a slip, a rename and a notice', () => {
    const panes = new PaneNotesStore();
    panes.showNote('p', 's', 'n1');
    panes.askDelete('p', 's', 'n1');
    panes.setNotice('p', 's', 'limit');
    panes.showTerminal('p', 's');
    expect(panes.get('p', 's')).toMatchObject({
      on: false,
      deleting: null,
      renaming: null,
      notice: null,
      noteId: 'n1',
    });
    expect(panes.takeTextFocus('p')).toBe(false);
  });

  it('a delete slip selects its note, keeps the keyboard for itself, and cancel gives it back', () => {
    const panes = new PaneNotesStore();
    panes.showNote('p', 's', 'n1');
    panes.askDelete('p', 's', 'n2');
    expect(panes.get('p', 's')).toMatchObject({ on: true, noteId: 'n2', deleting: 'n2' });
    expect(panes.takeTextFocus('p')).toBe(false);
    panes.cancelDelete('p', 's');
    expect(panes.get('p', 's')!.deleting).toBeNull();
    expect(panes.takeTextFocus('p')).toBe(true);
  });

  it('a notice brings the view up; switching notes clears it', () => {
    const panes = new PaneNotesStore();
    panes.setNotice('p', 's', 'limit');
    expect(panes.get('p', 's')).toMatchObject({ on: true, notice: 'limit' });
    panes.showNote('p', 's', 'n1');
    expect(panes.get('p', 's')!.notice).toBeNull();
  });

  it('remembers without notifying what the view resolved to', () => {
    const panes = new PaneNotesStore();
    panes.showNote('p', 's', null);
    const listener = vi.fn();
    panes.subscribe(listener);
    panes.remember('p', 's', 'n1');
    expect(listener).not.toHaveBeenCalled();
    expect(panes.get('p', 's')!.noteId).toBe('n1');
  });

  it('keeps carets per note and forgets panes that are gone', () => {
    const panes = new PaneNotesStore();
    panes.showNote('p', 's', 'n1');
    panes.showNote('q', 's2', 'n1');
    panes.saveCaret('p', 'n1', { start: 3, end: 4, scrollTop: 9 });
    expect(panes.caret('p', 'n1')).toEqual({ start: 3, end: 4, scrollTop: 9 });
    const listener = vi.fn();
    panes.subscribe(listener);
    panes.retain(new Set(['q']));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(panes.get('p', 's')).toBeNull();
    expect(panes.caret('p', 'n1')).toBeUndefined();
    expect(panes.isOn('q', 's2')).toBe(true);
    panes.retain(new Set(['q']));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
