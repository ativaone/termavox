import { uuidv7 } from '@termavox/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanNoteTitle,
  NOTE_TITLE_MAX,
  NOTES_PER_SESSION_MAX,
  noteBodyBytes,
} from '../lib/notes/limits.ts';
import {
  countNotesBySession,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
} from '../lib/repo/notes.ts';
import { createUser, makeRuntime, type TestRuntime } from './helpers.ts';

let t: TestRuntime;
let alice: string;
let bob: string;

beforeAll(async () => {
  t = makeRuntime();
  alice = (await createUser(t.rt, 'alice')).id;
  bob = (await createUser(t.rt, 'bob')).id;
});
afterAll(() => t.cleanup());

function addSession(userId: string, status = 'connected'): string {
  const id = uuidv7();
  t.rt.db.$client
    .prepare(
      `INSERT INTO sessions (id, user_id, target_kind, target_hostname, target_port,
         target_username, term, scrollback_lines, label, desired_state, state, status,
         tmux_token, cols, rows, created_at)
       VALUES (?, ?, 'ssh', '10.0.0.1', 22, 'deploy', 'xterm-256color', 5000, 'live',
               'running', 'ready', ?, 'tok', 80, 24, ?)`,
    )
    .run(id, userId, status, Date.now());
  return id;
}

function addNote(userId: string, sessionId: string, title = 'note', now?: number) {
  const created = createNote(t.rt.db, userId, sessionId, title, now);
  if (created.outcome !== 'ok') throw new Error(`create failed: ${created.outcome}`);
  return created.note;
}

function storedNotes(sessionId: string): number {
  const { total } = t.rt.db.$client
    .prepare('SELECT COUNT(*) AS total FROM session_notes WHERE session_id = ?')
    .get(sessionId) as { total: number };
  return total;
}

describe('session_notes table', () => {
  it('has the agreed columns, defaults, index and cascading foreign key', () => {
    const sqlite = t.rt.db.$client;
    const columns = sqlite.prepare('PRAGMA table_info(session_notes)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    expect(columns.map((c) => [c.name, c.notnull, c.dflt_value, c.pk])).toEqual([
      ['id', 1, null, 1],
      ['session_id', 1, null, 0],
      ['title', 1, null, 0],
      ['body', 1, "''", 0],
      ['revision', 1, '1', 0],
      ['created_at', 1, null, 0],
      ['updated_at', 1, null, 0],
    ]);
    expect(sqlite.prepare('PRAGMA index_info(session_notes_session_idx)').all()).toMatchObject([
      { name: 'session_id' },
    ]);
    expect(sqlite.prepare('PRAGMA foreign_key_list(session_notes)').all()).toMatchObject([
      { table: 'sessions', from: 'session_id', to: 'id', on_delete: 'CASCADE' },
    ]);
  });

  it('removes the notes with their session, and only those', () => {
    const gone = addSession(alice, 'ended');
    const kept = addSession(alice);
    addNote(alice, gone);
    addNote(alice, gone);
    addNote(alice, kept);
    t.rt.db.$client.prepare('DELETE FROM sessions WHERE id = ?').run(gone);
    expect(storedNotes(gone)).toBe(0);
    expect(storedNotes(kept)).toBe(1);
    expect(listNotes(t.rt.db, alice, gone)).toBeNull();
  });
});

describe('note repository', () => {
  it('creates at revision 1 and lists oldest first, for a session in any state', () => {
    const session = addSession(alice, 'ended');
    const late = addNote(alice, session, 'late', 2_000);
    const early = addNote(alice, session, 'early', 1_000);
    expect(early).toEqual({
      id: early.id,
      title: 'early',
      revision: 1,
      createdAt: 1_000,
      updatedAt: 1_000,
      bytes: 0,
      body: '',
    });
    expect(listNotes(t.rt.db, alice, session)?.map((n) => n.id)).toEqual([early.id, late.id]);
    expect(getNote(t.rt.db, alice, session, early.id)).toEqual(early);
  });

  it('enforces the per-session max when creating', () => {
    const session = addSession(alice);
    for (let i = 0; i < NOTES_PER_SESSION_MAX; i += 1) addNote(alice, session);
    expect(createNote(t.rt.db, alice, session, 'one more')).toEqual({ outcome: 'limit' });
    expect(storedNotes(session)).toBe(NOTES_PER_SESSION_MAX);
  });

  it('compares and swaps the revision: the second writer of a revision loses', () => {
    const session = addSession(alice);
    const note = addNote(alice, session, 'title', 1_000);

    const first = updateNote(t.rt.db, alice, session, note.id, { body: 'first' }, 1, 2_000);
    expect(first).toEqual({
      outcome: 'ok',
      note: {
        id: note.id,
        title: 'title',
        revision: 2,
        createdAt: 1_000,
        updatedAt: 2_000,
        bytes: 5,
      },
    });
    const second = updateNote(t.rt.db, alice, session, note.id, { body: 'second' }, 1, 3_000);
    expect(second).toEqual({ outcome: 'stale', revision: 2 });
    expect(getNote(t.rt.db, alice, session, note.id)).toMatchObject({
      body: 'first',
      revision: 2,
      updatedAt: 2_000,
    });
  });

  it('changes only the fields given, and an empty body clears it', () => {
    const session = addSession(alice);
    const note = addNote(alice, session, 'title');
    updateNote(t.rt.db, alice, session, note.id, { body: 'text' }, 1);
    updateNote(t.rt.db, alice, session, note.id, { title: 'renamed' }, 2);
    expect(getNote(t.rt.db, alice, session, note.id)).toMatchObject({
      title: 'renamed',
      body: 'text',
      bytes: 4,
      revision: 3,
    });
    updateNote(t.rt.db, alice, session, note.id, { body: '' }, 3);
    expect(getNote(t.rt.db, alice, session, note.id)).toMatchObject({
      title: 'renamed',
      body: '',
      bytes: 0,
      revision: 4,
    });
  });

  it('reports the body size in UTF-8 bytes', () => {
    const session = addSession(alice);
    const note = addNote(alice, session);
    const result = updateNote(t.rt.db, alice, session, note.id, { body: 'é😀\u0000x' }, 1);
    expect(result).toMatchObject({ outcome: 'ok', note: { bytes: 8 } });
    expect(listNotes(t.rt.db, alice, session)?.[0]?.bytes).toBe(8);
    expect(noteBodyBytes('é😀\u0000x')).toBe(8);
  });

  it("never sees or changes another user's notes", () => {
    const session = addSession(alice);
    const note = addNote(alice, session, 'private');
    updateNote(t.rt.db, alice, session, note.id, { body: 'secret' }, 1);

    expect(listNotes(t.rt.db, bob, session)).toBeNull();
    expect(getNote(t.rt.db, bob, session, note.id)).toBeNull();
    expect(createNote(t.rt.db, bob, session, 'intruder')).toEqual({ outcome: 'not-found' });
    expect(updateNote(t.rt.db, bob, session, note.id, { body: 'x' }, 2)).toEqual({
      outcome: 'not-found',
    });
    // A wrong revision must not reveal the current one either.
    expect(updateNote(t.rt.db, bob, session, note.id, { body: 'x' }, 1)).toEqual({
      outcome: 'not-found',
    });
    expect(deleteNote(t.rt.db, bob, session, note.id)).toBe(false);
    expect(getNote(t.rt.db, alice, session, note.id)).toMatchObject({
      title: 'private',
      body: 'secret',
      revision: 2,
    });
    expect(countNotesBySession(t.rt.db, bob)[session]).toBeUndefined();
  });

  it("does not reach a note through another session, even the same user's", () => {
    const session = addSession(alice);
    const other = addSession(alice);
    const note = addNote(alice, session);
    expect(getNote(t.rt.db, alice, other, note.id)).toBeNull();
    expect(updateNote(t.rt.db, alice, other, note.id, { body: 'x' }, 1)).toEqual({
      outcome: 'not-found',
    });
    expect(deleteNote(t.rt.db, alice, other, note.id)).toBe(false);
    expect(deleteNote(t.rt.db, alice, session, note.id)).toBe(true);
    expect(deleteNote(t.rt.db, alice, session, note.id)).toBe(false);
  });

  it('counts per session, only sessions with notes', () => {
    const owner = uuidv7();
    t.rt.db.$client
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, username, created_at, updated_at)
         VALUES (?, 'carol', 'carol@example.test', 0, 'carol', 0, 0)`,
      )
      .run(owner);
    const two = addSession(owner, 'ended');
    const one = addSession(owner);
    addSession(owner);
    addNote(owner, two);
    addNote(owner, two);
    addNote(owner, one);
    expect(countNotesBySession(t.rt.db, owner)).toEqual({ [two]: 2, [one]: 1 });
  });
});

describe('cleanNoteTitle', () => {
  it('drops control and invisible formatting characters, then trims', () => {
    expect(cleanNoteTitle('  a\u0000b​c‮d⁦e﻿\u009Ff\n ')).toBe('abcdef');
    expect(cleanNoteTitle('​  plan  ​')).toBe('plan');
    expect(cleanNoteTitle('ação 😀')).toBe('ação 😀');
  });

  it('returns null when nothing is left', () => {
    expect(cleanNoteTitle('')).toBeNull();
    expect(cleanNoteTitle('   ')).toBeNull();
    expect(cleanNoteTitle('​\u0007\t')).toBeNull();
  });

  it('measures the cleaned title in code points', () => {
    const max = '😀'.repeat(NOTE_TITLE_MAX);
    expect(cleanNoteTitle(max)).toBe(max);
    expect(cleanNoteTitle(`${max}😀`)).toBeNull();
    expect(cleanNoteTitle(`  ${max}​${'\u0007'.repeat(10)}  `)).toBe(max);
  });
});
