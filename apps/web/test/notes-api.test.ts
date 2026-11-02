import { uuidv7 } from '@termavox/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOTE_BODY_MAX_BYTES, NOTE_TITLE_MAX, NOTES_PER_SESSION_MAX } from '../lib/notes/limits.ts';
import {
  deleteNoteResponse,
  getNoteResponse,
  getNotesResponse,
  MAX_PATCH_BYTES,
  patchNoteResponse,
  postNoteResponse,
} from '../lib/notes-api.ts';
import { createNote, getNote } from '../lib/repo/notes.ts';
import {
  createUser,
  type Jar,
  makeRuntime,
  PUBLIC_URL,
  signIn,
  type TestRuntime,
} from './helpers.ts';

let t: TestRuntime;
let ann: { id: string; jar: Jar };
let ben: { id: string; jar: Jar };
let annSession: string;

const NOT_FOUND = { code: 'NOT_FOUND', message: 'not found' };

beforeAll(async () => {
  t = makeRuntime();
  const a = await createUser(t.rt, 'ann');
  const b = await createUser(t.rt, 'ben');
  ann = { id: a.id, jar: (await signIn(t.rt, 'ann')).jar };
  ben = { id: b.id, jar: (await signIn(t.rt, 'ben')).jar };
  annSession = addSession(ann.id);
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

function url(sessionId: string, noteId?: string): string {
  const base = `${PUBLIC_URL}/api/sessions/${sessionId}/notes`;
  return noteId === undefined ? base : `${base}/${noteId}`;
}

interface WriteOptions {
  /** Ann's by default. */
  jar?: Jar;
  anonymous?: boolean;
  origin?: string | null;
  ifMatch?: string | null;
  contentLength?: string;
}

function writeRequest(method: string, target: string, opts: WriteOptions, body?: unknown): Request {
  const jar = opts.anonymous ? undefined : (opts.jar ?? ann.jar);
  const headers = jar?.headers() ?? new Headers();
  const origin = opts.origin === undefined ? PUBLIC_URL : opts.origin;
  if (origin) headers.set('origin', origin);
  if (opts.ifMatch) headers.set('if-match', opts.ifMatch);
  if (opts.contentLength) headers.set('content-length', opts.contentLength);
  if (body === undefined) return new Request(target, { method, headers });
  headers.set('content-type', 'application/json');
  return new Request(target, {
    method,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function list(sessionId: string, jar?: Jar, extra: Record<string, string> = {}) {
  const headers = jar?.headers(extra) ?? new Headers(extra);
  return getNotesResponse(t.rt, new Request(url(sessionId), { headers }), sessionId);
}

function post(sessionId: string, body: unknown, opts: WriteOptions = {}) {
  return postNoteResponse(t.rt, writeRequest('POST', url(sessionId), opts, body), sessionId);
}

function read(sessionId: string, noteId: string, jar?: Jar, extra: Record<string, string> = {}) {
  const headers = jar?.headers(extra) ?? new Headers(extra);
  return getNoteResponse(t.rt, new Request(url(sessionId, noteId), { headers }), sessionId, noteId);
}

function patch(sessionId: string, noteId: string, body: unknown, opts: WriteOptions = {}) {
  const ifMatch = opts.ifMatch === undefined ? '"1"' : opts.ifMatch;
  return patchNoteResponse(
    t.rt,
    writeRequest('PATCH', url(sessionId, noteId), { ...opts, ifMatch }, body),
    sessionId,
    noteId,
  );
}

function remove(sessionId: string, noteId: string, opts: WriteOptions = {}) {
  return deleteNoteResponse(
    t.rt,
    writeRequest('DELETE', url(sessionId, noteId), opts),
    sessionId,
    noteId,
  );
}

/** A fresh note of Ann's through the repository, for tests about something else. */
function seedNote(sessionId: string = annSession, title = 'seed'): string {
  const created = createNote(t.rt.db, ann.id, sessionId, title);
  if (created.outcome !== 'ok') throw new Error(`seed failed: ${created.outcome}`);
  return created.note.id;
}

describe('GET /api/sessions/:sessionId/notes', () => {
  it('lists metas oldest first, without bodies, for a session in any state', async () => {
    const session = addSession(ann.id, 'ended');
    const empty = await list(session, ann.jar);
    expect(empty.status).toBe(200);
    expect(empty.headers.get('cache-control')).toBe('no-store');
    expect(await empty.json()).toEqual({ notes: [] });

    const second = createNote(t.rt.db, ann.id, session, 'second', 2_000);
    const first = createNote(t.rt.db, ann.id, session, 'first', 1_000);
    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('seed failed');
    await patch(session, first.note.id, { body: 'héllo' });

    const res = await list(session, ann.jar, { 'sec-fetch-site': 'same-origin' });
    const { notes } = (await res.json()) as { notes: { updatedAt: number }[] };
    expect(notes).toEqual([
      {
        id: first.note.id,
        title: 'first',
        revision: 2,
        createdAt: 1_000,
        updatedAt: notes[0]!.updatedAt,
        bytes: 6,
      },
      {
        id: second.note.id,
        title: 'second',
        revision: 1,
        createdAt: 2_000,
        updatedAt: 2_000,
        bytes: 0,
      },
    ]);
  });

  it('answers 404 for a session that does not exist', async () => {
    const res = await list('nope', ann.jar);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });
});

describe('POST /api/sessions/:sessionId/notes', () => {
  it('creates an empty note and stores the cleaned title', async () => {
    const before = Date.now();
    const res = await post(annSession, { title: '  dep​loy\u0007 plan ' });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { note } = (await res.json()) as {
      note: { id: string; createdAt: number; updatedAt: number };
    };
    expect(note).toEqual({
      id: note.id,
      title: 'deploy plan',
      revision: 1,
      createdAt: note.createdAt,
      updatedAt: note.createdAt,
      bytes: 0,
      body: '',
    });
    expect(note.createdAt).toBeGreaterThanOrEqual(before);
    expect(getNote(t.rt.db, ann.id, annSession, note.id)?.title).toBe('deploy plan');
  });

  it('counts the title in code points', async () => {
    expect((await post(annSession, { title: '😀'.repeat(NOTE_TITLE_MAX) })).status).toBe(201);
    expect((await post(annSession, { title: '😀'.repeat(NOTE_TITLE_MAX + 1) })).status).toBe(400);
  });

  it.each([
    ['an empty title', { title: '' }],
    ['blanks only', { title: '   ' }],
    ['invisible formatting only', { title: '​‮\u0007' }],
    ['a long title', { title: 'x'.repeat(NOTE_TITLE_MAX + 1) }],
    ['a non-string title', { title: 7 }],
    ['no title', {}],
    ['a JSON array', []],
    ['JSON null', 'null'],
    ['malformed JSON', '{not json'],
  ])('answers 400 for %s', async (_name, body) => {
    const res = await post(annSession, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('answers 413 for a request far larger than a title', async () => {
    expect((await post(annSession, { title: 'x'.repeat(5_000) })).status).toBe(413);
  });

  it('answers 409 reason limit at the per-session max', async () => {
    const session = addSession(ann.id);
    const ids = Array.from({ length: NOTES_PER_SESSION_MAX }, () => seedNote(session));
    const res = await post(session, { title: 'one more' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'CONFLICT',
      message: 'too many notes in this session',
      reason: 'limit',
    });
    expect((await remove(session, ids[0]!)).status).toBe(204);
    expect((await post(session, { title: 'one more' })).status).toBe(201);
    // The limit is per session.
    expect((await post(addSession(ann.id), { title: 'elsewhere' })).status).toBe(201);
  });

  it('answers 404 for a session that does not exist', async () => {
    const res = await post('nope', { title: 'x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });
});

describe('GET /api/sessions/:sessionId/notes/:noteId', () => {
  it('returns the note with its body', async () => {
    const id = seedNote(annSession, 'with body');
    await patch(annSession, id, { body: 'a\nb\u0000é😀' });
    const res = await read(annSession, id, ann.jar);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({
      note: { id, title: 'with body', revision: 2, body: 'a\nb\u0000é😀', bytes: 10 },
    });
  });

  it('answers 404 for a note that does not exist', async () => {
    const res = await read(annSession, 'nope', ann.jar);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });
});

describe('PATCH /api/sessions/:sessionId/notes/:noteId', () => {
  it('changes the title, the body or both, one revision at a time, and returns the meta', async () => {
    const id = seedNote();
    const body = await patch(annSession, id, { body: 'ção' }, { ifMatch: '1' });
    expect(body.status).toBe(200);
    expect(body.headers.get('cache-control')).toBe('no-store');
    expect(await body.json()).toMatchObject({ note: { id, title: 'seed', revision: 2, bytes: 5 } });

    const title = await patch(annSession, id, { title: ' new​ ' }, { ifMatch: '"2"' });
    const { note } = (await title.json()) as { note: Record<string, unknown> };
    expect(note).toMatchObject({ title: 'new', revision: 3, bytes: 5 });
    expect(note).not.toHaveProperty('body');
    expect(getNote(t.rt.db, ann.id, annSession, id)?.body).toBe('ção');

    const both = await patch(annSession, id, { title: 'both', body: '' }, { ifMatch: 'W/"3"' });
    expect(await both.json()).toMatchObject({ note: { title: 'both', revision: 4, bytes: 0 } });
    expect(getNote(t.rt.db, ann.id, annSession, id)?.body).toBe('');
  });

  it('answers a stale revision with 409 and the current one, and changes nothing', async () => {
    const id = seedNote();
    await patch(annSession, id, { body: 'kept' });
    const res = await patch(annSession, id, { body: 'overwrite' }, { ifMatch: '"1"' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'CONFLICT',
      message: 'note changed',
      reason: 'stale',
      revision: 2,
    });
    expect(getNote(t.rt.db, ann.id, annSession, id)).toMatchObject({ body: 'kept', revision: 2 });
  });

  it('answers 428 without a usable If-Match', async () => {
    const id = seedNote();
    expect((await patch(annSession, id, { body: 'x' }, { ifMatch: null })).status).toBe(428);
    expect((await patch(annSession, id, { body: 'x' }, { ifMatch: '*' })).status).toBe(428);
  });

  it.each([
    ['nothing to change', {}],
    ['only unknown fields', { other: 'x' }],
    ['an empty title', { title: ' ' }],
    ['a long title', { title: 'x'.repeat(NOTE_TITLE_MAX + 1) }],
    ['a non-string title', { title: null }],
    ['a non-string body', { body: 7 }],
    ['malformed JSON', '{not json'],
  ])('answers 400 for %s', async (_name, payload) => {
    const id = seedNote();
    const res = await patch(annSession, id, payload);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    expect(getNote(t.rt.db, ann.id, annSession, id)?.revision).toBe(1);
  });

  it('limits the body in UTF-8 bytes, not characters', async () => {
    const id = seedNote();
    const exact = 'é'.repeat(NOTE_BODY_MAX_BYTES / 2);
    const fits = await patch(annSession, id, { body: exact });
    expect(fits.status).toBe(200);
    expect(await fits.json()).toMatchObject({ note: { bytes: NOTE_BODY_MAX_BYTES } });

    const over = await patch(annSession, id, { body: `${exact}a` }, { ifMatch: '2' });
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ code: 'BAD_REQUEST' });
    const ascii = await patch(
      annSession,
      id,
      { body: 'a'.repeat(NOTE_BODY_MAX_BYTES + 1) },
      { ifMatch: '2' },
    );
    expect(ascii.status).toBe(413);
    expect(getNote(t.rt.db, ann.id, annSession, id)?.revision).toBe(2);
  });

  it('takes a maximal body whose JSON escaping makes the request six times larger', async () => {
    const id = seedNote();
    const body = '\u0001'.repeat(NOTE_BODY_MAX_BYTES);
    expect(JSON.stringify({ body }).length).toBeGreaterThan(6 * NOTE_BODY_MAX_BYTES);
    const res = await patch(annSession, id, { body, title: 'x'.repeat(NOTE_TITLE_MAX) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ note: { bytes: NOTE_BODY_MAX_BYTES } });
    expect(getNote(t.rt.db, ann.id, annSession, id)?.body).toBe(body);
  });

  it('checks the declared size before reading and the real size after', async () => {
    const id = seedNote();
    const declared = await patch(
      annSession,
      id,
      { body: 'small' },
      { contentLength: String(MAX_PATCH_BYTES + 1) },
    );
    expect(declared.status).toBe(413);
    const real = await patch(annSession, id, {
      body: 'x'.repeat(MAX_PATCH_BYTES),
    });
    expect(real.status).toBe(413);
    expect(getNote(t.rt.db, ann.id, annSession, id)?.revision).toBe(1);
  });

  it('answers 404 for a note that does not exist', async () => {
    const res = await patch(annSession, 'nope', { body: 'x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });
});

describe('DELETE /api/sessions/:sessionId/notes/:noteId', () => {
  it('answers 204 without If-Match, then 404', async () => {
    const id = seedNote();
    const res = await remove(annSession, id);
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
    const again = await remove(annSession, id);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual(NOT_FOUND);
    expect((await read(annSession, id, ann.jar)).status).toBe(404);
  });
});

describe('isolation', () => {
  it("answers 404, with the same body as a missing one, for another user's session and note", async () => {
    const id = seedNote(annSession, 'private');
    const answers = await Promise.all([
      list(annSession, ben.jar),
      post(annSession, { title: 'intruder' }, { jar: ben.jar }),
      read(annSession, id, ben.jar),
      patch(annSession, id, { body: 'intruder' }, { jar: ben.jar }),
      remove(annSession, id, { jar: ben.jar }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    expect(getNote(t.rt.db, ann.id, annSession, id)).toMatchObject({
      title: 'private',
      body: '',
      revision: 1,
    });
    const notes = (await (await list(annSession, ann.jar)).json()) as {
      notes: { title: string }[];
    };
    expect(notes.notes.map((n) => n.title)).not.toContain('intruder');
  });

  it("answers 404 for a user's own note reached through another session of theirs", async () => {
    const id = seedNote(annSession, 'here');
    const other = addSession(ann.id);
    expect((await read(other, id, ann.jar)).status).toBe(404);
    expect((await patch(other, id, { body: 'x' })).status).toBe(404);
    expect((await remove(other, id)).status).toBe(404);
    expect(getNote(t.rt.db, ann.id, annSession, id)).toMatchObject({ body: '', revision: 1 });
  });

  it('removes the notes with the session, which then answers 404', async () => {
    const session = addSession(ann.id, 'ended');
    const id = seedNote(session);
    t.rt.db.$client.prepare('DELETE FROM sessions WHERE id = ?').run(session);
    expect((await list(session, ann.jar)).status).toBe(404);
    expect((await read(session, id, ann.jar)).status).toBe(404);
    const { total } = t.rt.db.$client
      .prepare('SELECT COUNT(*) AS total FROM session_notes WHERE session_id = ?')
      .get(session) as { total: number };
    expect(total).toBe(0);
  });
});

describe('auth and origin', () => {
  it('answers 401 without a session', async () => {
    const id = seedNote();
    const anonymous = { anonymous: true };
    const answers = await Promise.all([
      list(annSession),
      post(annSession, { title: 'x' }, anonymous),
      read(annSession, id),
      patch(annSession, id, { body: 'x' }, anonymous),
      remove(annSession, id, anonymous),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it.each([
    ['password change', { mustChangePassword: true }],
    ['TOTP enrollment', { totpRequired: true }],
  ])('answers 403 while a %s is pending', async (name, extra) => {
    const username = name === 'password change' ? 'pam' : 'tom';
    await createUser(t.rt, username, extra);
    const { jar } = await signIn(t.rt, username);
    const id = seedNote();
    const answers = await Promise.all([
      list(annSession, jar),
      post(annSession, { title: 'x' }, { jar }),
      read(annSession, id, jar),
      patch(annSession, id, { body: 'x' }, { jar }),
      remove(annSession, id, { jar }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it.each([
    ['a foreign Origin', 'https://evil.example'],
    ['no Origin', null],
  ])('refuses a mutation with %s', async (_name, origin) => {
    const id = seedNote();
    const answers = await Promise.all([
      post(annSession, { title: 'x' }, { origin }),
      patch(annSession, id, { body: 'x' }, { origin }),
      remove(annSession, id, { origin }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'FORBIDDEN', message: 'origin not allowed' });
    }
    expect(getNote(t.rt.db, ann.id, annSession, id)?.revision).toBe(1);
  });

  it('refuses a GET with a foreign Origin or Sec-Fetch-Site', async () => {
    const id = seedNote();
    const foreign: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
    ];
    for (const extra of foreign) {
      expect((await list(annSession, ann.jar, extra)).status).toBe(403);
      expect((await read(annSession, id, ann.jar, extra)).status).toBe(403);
    }
    const same = { origin: PUBLIC_URL, 'sec-fetch-site': 'same-origin' };
    expect((await list(annSession, ann.jar, same)).status).toBe(200);
    expect((await read(annSession, id, ann.jar, same)).status).toBe(200);
  });
});

describe('logging', () => {
  it('never logs a title or a body', async () => {
    const res = await post(annSession, { title: 'title-canary' });
    const { note } = (await res.json()) as { note: { id: string } };
    await patch(annSession, note.id, { body: 'body-canary' });
    const logged = t.logs.join('\n');
    expect(logged).not.toContain('title-canary');
    expect(logged).not.toContain('body-canary');
  });
});
