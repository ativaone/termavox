import '../server-guard.ts';
import type { TermavoxDb } from '@termavox/db';
import { uuidv7 } from '@termavox/shared';
import { NOTES_PER_SESSION_MAX } from '../notes/limits.ts';
import type { Note, NoteMeta } from '../notes/types.ts';

/**
 * Session notes (plan D-58; web owns `session_notes`). Every statement goes through
 * `sessions.user_id = ?`, so a user only ever sees or changes the notes of their own sessions,
 * in any state. A note is addressed by its session and its id, both of which must match. Titles
 * and bodies arrive validated (lib/notes/limits.ts, lib/notes-api.ts).
 */

interface MetaRow {
  id: string;
  title: string;
  revision: number;
  created_at: number;
  updated_at: number;
  bytes: number;
}

// octet_length reads the size from the record header, without loading the body.
const META_COLUMNS = `n.id, n.title, n.revision, n.created_at, n.updated_at,
  octet_length(n.body) AS bytes`;

function toMeta(row: MetaRow): NoteMeta {
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bytes: row.bytes,
  };
}

/** The notes of a session, oldest first; null when the user has no such session. */
export function listNotes(db: TermavoxDb, userId: string, sessionId: string): NoteMeta[] | null {
  const sqlite = db.$client;
  const owned = sqlite
    .prepare('SELECT 1 FROM sessions s WHERE s.id = ? AND s.user_id = ?')
    .get(sessionId, userId);
  if (owned === undefined) return null;
  const rows = sqlite
    .prepare(
      `SELECT ${META_COLUMNS} FROM session_notes n JOIN sessions s ON s.id = n.session_id
       WHERE n.session_id = ? AND s.user_id = ? ORDER BY n.created_at, n.id`,
    )
    .all(sessionId, userId) as MetaRow[];
  return rows.map(toMeta);
}

function getMeta(
  db: TermavoxDb,
  userId: string,
  sessionId: string,
  noteId: string,
): NoteMeta | null {
  const row = db.$client
    .prepare(
      `SELECT ${META_COLUMNS} FROM session_notes n JOIN sessions s ON s.id = n.session_id
       WHERE n.id = ? AND n.session_id = ? AND s.user_id = ?`,
    )
    .get(noteId, sessionId, userId) as MetaRow | undefined;
  return row ? toMeta(row) : null;
}

export function getNote(
  db: TermavoxDb,
  userId: string,
  sessionId: string,
  noteId: string,
): Note | null {
  const row = db.$client
    .prepare(
      `SELECT ${META_COLUMNS}, n.body FROM session_notes n JOIN sessions s ON s.id = n.session_id
       WHERE n.id = ? AND n.session_id = ? AND s.user_id = ?`,
    )
    .get(noteId, sessionId, userId) as (MetaRow & { body: string }) | undefined;
  return row ? { ...toMeta(row), body: row.body } : null;
}

export type CreateNoteResult =
  | { outcome: 'ok'; note: Note }
  | { outcome: 'not-found' }
  | { outcome: 'limit' };

/** Adds an empty note at revision 1, unless the session already holds NOTES_PER_SESSION_MAX. */
export function createNote(
  db: TermavoxDb,
  userId: string,
  sessionId: string,
  title: string,
  now: number = Date.now(),
): CreateNoteResult {
  const sqlite = db.$client;
  const write = sqlite.transaction((): CreateNoteResult => {
    const { total } = sqlite
      .prepare(
        `SELECT COUNT(*) AS total FROM session_notes n JOIN sessions s ON s.id = n.session_id
         WHERE n.session_id = ? AND s.user_id = ?`,
      )
      .get(sessionId, userId) as { total: number };
    if (total >= NOTES_PER_SESSION_MAX) return { outcome: 'limit' };
    const id = uuidv7(now);
    const { changes } = sqlite
      .prepare(
        `INSERT INTO session_notes (id, session_id, title, created_at, updated_at)
         SELECT ?, s.id, ?, ?, ? FROM sessions s WHERE s.id = ? AND s.user_id = ?`,
      )
      .run(id, title, now, now, sessionId, userId);
    if (changes === 0) return { outcome: 'not-found' };
    return {
      outcome: 'ok',
      note: {
        id,
        title,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        bytes: 0,
        body: '',
      },
    };
  });
  return write.immediate();
}

export type UpdateNoteResult =
  | { outcome: 'ok'; note: NoteMeta }
  | { outcome: 'not-found' }
  | { outcome: 'stale'; revision: number };

/** Changes what `changes` carries if the note is still at `expectedRevision` (revision + 1). */
export function updateNote(
  db: TermavoxDb,
  userId: string,
  sessionId: string,
  noteId: string,
  changes: { title?: string; body?: string },
  expectedRevision: number,
  now: number = Date.now(),
): UpdateNoteResult {
  const sqlite = db.$client;
  const write = sqlite.transaction((): UpdateNoteResult => {
    const updated = sqlite
      .prepare(
        `UPDATE session_notes
         SET title = COALESCE(?, title), body = COALESCE(?, body),
             revision = revision + 1, updated_at = ?
         WHERE id = ? AND session_id = ? AND revision = ?
           AND EXISTS (SELECT 1 FROM sessions s
                       WHERE s.id = session_notes.session_id AND s.user_id = ?)`,
      )
      .run(
        changes.title ?? null,
        changes.body ?? null,
        now,
        noteId,
        sessionId,
        expectedRevision,
        userId,
      );
    const note = getMeta(db, userId, sessionId, noteId);
    if (note === null) return { outcome: 'not-found' };
    if (updated.changes === 0) return { outcome: 'stale', revision: note.revision };
    return { outcome: 'ok', note };
  });
  return write.immediate();
}

export type DeleteNoteResult =
  | { outcome: 'ok' }
  | { outcome: 'not-found' }
  | { outcome: 'stale'; revision: number };

/**
 * Deletes a note; with `expectedRevision`, only if it is still at that revision, checked by the
 * delete statement itself so nothing written in between can be lost.
 */
export function deleteNote(
  db: TermavoxDb,
  userId: string,
  sessionId: string,
  noteId: string,
  expectedRevision?: number,
): DeleteNoteResult {
  const expected = expectedRevision ?? null;
  const { changes } = db.$client
    .prepare(
      `DELETE FROM session_notes
       WHERE id = ? AND session_id = ? AND (? IS NULL OR revision = ?)
         AND EXISTS (SELECT 1 FROM sessions s
                     WHERE s.id = session_notes.session_id AND s.user_id = ?)`,
    )
    .run(noteId, sessionId, expected, expected, userId);
  if (changes > 0) return { outcome: 'ok' };
  const note = expected === null ? null : getMeta(db, userId, sessionId, noteId);
  return note ? { outcome: 'stale', revision: note.revision } : { outcome: 'not-found' };
}

/** Session id → how many notes, for every session of the user that has any. */
export function countNotesBySession(db: TermavoxDb, userId: string): Record<string, number> {
  const rows = db.$client
    .prepare(
      `SELECT n.session_id AS id, COUNT(*) AS total
       FROM session_notes n JOIN sessions s ON s.id = n.session_id
       WHERE s.user_id = ? GROUP BY n.session_id`,
    )
    .all(userId) as { id: string; total: number }[];
  return Object.fromEntries(rows.map((row) => [row.id, row.total]));
}
