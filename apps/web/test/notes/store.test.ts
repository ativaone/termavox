import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTE_BODY_MAX_BYTES, NOTES_PER_SESSION_MAX } from '../../lib/notes/limits.ts';
import { lowestFreeNoteTitle } from '../../lib/notes/naming.ts';
import {
  EXIT_FLUSH_MAX_BYTES,
  NotesStore,
  noteCharacters,
  RETRY_DELAYS_MS,
  SAVE_DEBOUNCE_MS,
} from '../../lib/notes/store.ts';
import type { NoteMeta } from '../../lib/notes/types.ts';

const meta = (id: string, patch: Partial<NoteMeta> = {}): NoteMeta => ({
  id,
  title: `Title ${id}`,
  revision: 1,
  createdAt: Number(id.replace(/\D/g, '')) || 1,
  updatedAt: 1,
  bytes: 0,
  ...patch,
});

interface Call {
  url: string;
  method: string;
  body: { title?: string; body?: string } | null;
  ifMatch: string | null;
  keepalive: boolean;
  respond(status: number, json?: unknown): Promise<void>;
  fail(): Promise<void>;
}

/** A fetch whose answers the test gives, one call at a time. */
function fakeFetch() {
  const calls: Call[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const settle = async () => {
        await vi.advanceTimersByTimeAsync(0);
      };
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Call['body']) : null,
        ifMatch: headers['if-match'] ?? null,
        keepalive: init?.keepalive ?? false,
        respond: async (status, json) => {
          resolve(new Response(status === 204 ? null : JSON.stringify(json ?? {}), { status }));
          await settle();
        },
        fail: async () => {
          reject(new TypeError('network'));
          await settle();
        },
      });
    })) as typeof fetch;
  return { calls, impl };
}

const S = 's1';
const N = 'n1';

/** A store with one loaded note, its body `body`, revision 1. */
async function withNote(body = 'hello', counts: Record<string, number> = {}) {
  const { calls, impl } = fakeFetch();
  const store = new NotesStore({ fetch: impl, counts });
  store.ensureList(S);
  await calls.at(-1)!.respond(200, { notes: [meta(N, { bytes: body.length })] });
  store.ensureBody(S, N);
  await calls.at(-1)!.respond(200, { note: { ...meta(N), body } });
  calls.length = 0;
  return { store, calls };
}

const saved = (id = N, patch: Partial<NoteMeta> = {}) => ({
  note: meta(id, { revision: 2, updatedAt: 500, ...patch }),
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('notes store: lists and bodies', () => {
  it('fetches a list once, and a failed one again', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    expect(store.getSession(S).list).toBe('idle');
    store.ensureList(S);
    store.ensureList(S);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`/api/sessions/${S}/notes`);
    expect(store.getSession(S).list).toBe('loading');
    await calls[0]!.fail();
    expect(store.getSession(S).list).toBe('error');
    store.ensureList(S);
    await calls[1]!.respond(200, { notes: [meta('n2'), meta('n1')] });
    expect(store.getSession(S).list).toBe('ready');
    expect(store.getSession(S).notes.map((n) => n.id)).toEqual(['n1', 'n2']);
    store.ensureList(S);
    expect(calls).toHaveLength(2);
  });

  it('says when a list failed because the sign-in ended', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(401, {});
    expect(store.getSession(S)).toMatchObject({ list: 'error', listSignIn: true });
  });

  it('loads a body once when a note opens, and never edits before that', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [meta(N, { bytes: 3 })] });
    expect(store.getNote(S, N)).toMatchObject({ body: 'idle', draft: '', bytes: 3 });
    store.edit(S, N, 'too early');
    expect(store.getNote(S, N)!.draft).toBe('');
    store.ensureBody(S, N);
    store.ensureBody(S, N);
    expect(calls).toHaveLength(2);
    expect(store.getNote(S, N)!.body).toBe('loading');
    await calls[1]!.respond(200, { note: { ...meta(N, { revision: 4 }), body: 'abc' } });
    expect(store.getNote(S, N)).toMatchObject({ body: 'ready', draft: 'abc', save: 'saved' });
    expect(store.hasUnsaved()).toBe(false);
  });

  it('a body that fails can be tried again, and sign-in failures say so', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [meta(N)] });
    store.ensureBody(S, N);
    await calls[1]!.respond(403, {});
    expect(store.getNote(S, N)).toMatchObject({ body: 'failed', bodySignIn: true });
    store.ensureBody(S, N);
    expect(calls).toHaveLength(3);
  });

  it('keeps the snapshots stable until something changes', async () => {
    const { store } = await withNote();
    const session = store.getSession(S);
    const note = store.getNote(S, N);
    expect(store.getSession(S)).toBe(session);
    expect(store.getNote(S, N)).toBe(note);
    store.edit(S, N, 'typed');
    expect(store.getNote(S, N)).not.toBe(note);
    // Typing does not touch the list of notes.
    expect(store.getSession(S)).toBe(session);
  });
});

describe('notes store: saving', () => {
  it('saves a second after the last edit, with If-Match and only the body', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'a');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    store.edit(S, N, 'ab');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(calls).toHaveLength(0);
    expect(store.getNote(S, N)!.save).toBe('pending');
    expect(store.hasUnsaved()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `/api/sessions/${S}/notes/${N}`,
      ifMatch: '"1"',
      body: { body: 'ab' },
    });
    expect(store.getNote(S, N)!.save).toBe('saving');
    await calls[0]!.respond(200, saved());
    expect(store.getNote(S, N)).toMatchObject({ save: 'saved', updatedAt: 500 });
    expect(store.hasUnsaved()).toBe(false);
    expect(store.getSession(S).notes[0]!.revision).toBe(2);
  });

  it('sends nothing when the text went back to what the server has', async () => {
    const { store, calls } = await withNote('same');
    store.edit(S, N, 'other');
    store.edit(S, N, 'same');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(0);
    expect(store.getNote(S, N)!.save).toBe('saved');
  });

  it('keeps one PATCH in flight and queues one more with the latest text', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'one');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    store.edit(S, N, 'two');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    store.edit(S, N, 'three');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    await calls[0]!.respond(200, saved());
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ ifMatch: '"2"', body: { body: 'three' } });
    await calls[1]!.respond(200, saved(N, { revision: 3 }));
    expect(store.getNote(S, N)!.save).toBe('saved');
    expect(calls).toHaveLength(2);
  });

  it('an edit during a PATCH still waits for its debounce once that PATCH returns', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'one');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    store.edit(S, N, 'two');
    await calls[0]!.respond(200, saved());
    expect(calls).toHaveLength(1);
    expect(store.getNote(S, N)!.save).toBe('pending');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
  });

  it('flushes at once: one note, a session, or all of them', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'now');
    store.flush(S, 'another');
    expect(calls).toHaveLength(0);
    store.flush(S, N);
    expect(calls).toHaveLength(1);
    await calls[0]!.respond(200, saved());
    store.edit(S, N, 'later');
    store.flushAll();
    expect(calls).toHaveLength(2);
    await calls[1]!.respond(200, saved(N, { revision: 3 }));
    // Nothing waits any more: the debounce was cancelled by the flush.
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 3);
    expect(calls).toHaveLength(2);
  });

  it('keeps saving with no pane on screen (nothing here depends on a component)', async () => {
    const { store, calls } = await withNote();
    const unsubscribe = store.subscribe(() => {});
    store.edit(S, N, 'typed');
    unsubscribe();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
  });

  it('renames at once, sending only the title, and keeps the optimistic title', async () => {
    const { store, calls } = await withNote();
    expect(store.rename(S, N, '  ')).toBe('invalid');
    expect(store.rename(S, N, 'x'.repeat(81))).toBe('invalid');
    expect(calls).toHaveLength(0);
    expect(store.rename(S, N, '  Plans ')).toBe('ok');
    expect(calls[0]).toMatchObject({ body: { title: 'Plans' } });
    expect(store.getSession(S).notes[0]!.title).toBe('Plans');
    expect(store.hasUnsaved()).toBe(true);
    await calls[0]!.respond(200, saved(N, { title: 'Plans' }));
    expect(store.hasUnsaved()).toBe(false);
    expect(store.getNote(S, N)!.save).toBe('saved');
  });

  it('sends a title and body together when both wait', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'text');
    store.rename(S, N, 'Plans');
    expect(calls[0]!.body).toEqual({ title: 'Plans', body: 'text' });
  });

  it('a refused title goes back to the old one and says so', async () => {
    const { store, calls } = await withNote();
    store.rename(S, N, 'Plans');
    await calls[0]!.respond(400, {});
    expect(store.getNote(S, N)).toMatchObject({
      title: `Title ${N}`,
      titleRefused: true,
      save: 'saved',
    });
    expect(store.getSession(S).notes[0]!.title).toBe(`Title ${N}`);
  });

  it('renaming needs no loaded body', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [meta(N, { bytes: 9 })] });
    store.rename(S, N, 'New');
    expect(calls[1]!.body).toEqual({ title: 'New' });
  });
});

describe('notes store: when saving fails', () => {
  it('retries with backoff (2, 5, 15, then every 30 s) on network errors and 5xx', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'text');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await calls[0]!.fail();
    expect(store.getNote(S, N)!.save).toBe('retrying');
    expect(store.hasUnsaved()).toBe(true);
    const delays = [...RETRY_DELAYS_MS, RETRY_DELAYS_MS.at(-1)!];
    expect(delays).toEqual([2_000, 5_000, 15_000, 30_000, 30_000]);
    for (const [i, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(calls).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(i + 2);
      expect(store.getNote(S, N)!.save).toBe('retrying');
      await calls.at(-1)!.respond(i % 2 === 0 ? 503 : 500, {});
    }
    const last = calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(last + 1);
    await calls.at(-1)!.respond(200, saved());
    expect(store.getNote(S, N)!.save).toBe('saved');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(last + 1);
  });

  it('starts the backoff over after a success', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'a');
    store.flush(S);
    await calls[0]!.fail();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    await calls[1]!.respond(200, saved());
    store.edit(S, N, 'b');
    store.flush(S);
    await calls[2]!.fail();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(calls).toHaveLength(4);
  });

  it('tries at once when the network comes back', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'text');
    store.flush(S);
    await calls[0]!.fail();
    store.online();
    expect(calls).toHaveLength(2);
    await calls[1]!.respond(200, saved());
    expect(store.getNote(S, N)!.save).toBe('saved');
    // The pending retry was cancelled.
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(calls).toHaveLength(2);
  });

  it('a stale save is a conflict; "the other version" replaces the draft', async () => {
    const { store, calls } = await withNote('mine?');
    store.edit(S, N, 'mine');
    store.flush(S);
    await calls[0]!.respond(409, { reason: 'stale', revision: 7 });
    expect(store.getNote(S, N)).toMatchObject({ save: 'conflict', draft: 'mine' });
    expect(store.hasUnsaved()).toBe(true);
    // Text can still change, but nothing goes out while it asks.
    store.edit(S, N, 'mine, more');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(1);
    const loading = store.loadOther(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[1]!.respond(200, {
      note: { ...meta(N, { revision: 7, updatedAt: 900 }), body: 'theirs' },
    });
    await expect(loading).resolves.toBe(true);
    expect(store.getNote(S, N)).toMatchObject({ save: 'saved', draft: 'theirs', updatedAt: 900 });
    expect(store.hasUnsaved()).toBe(false);
    store.edit(S, N, 'theirs!');
    store.flush(S);
    expect(calls[2]).toMatchObject({ ifMatch: '"7"', body: { body: 'theirs!' } });
  });

  it('a failed load of the other version keeps the conflict', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'mine');
    store.flush(S);
    await calls[0]!.respond(409, { reason: 'stale', revision: 7 });
    const loading = store.loadOther(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[1]!.fail();
    await expect(loading).resolves.toBe(false);
    expect(store.getNote(S, N)).toMatchObject({ save: 'conflict', draft: 'mine' });
  });

  it('"keep mine" adopts the current revision and saves over it, even an unchanged body', async () => {
    const { store, calls } = await withNote('base');
    store.edit(S, N, 'mine');
    store.flush(S);
    await calls[0]!.respond(409, { reason: 'stale', revision: 7 });
    store.edit(S, N, 'base');
    store.keepMine(S, N);
    expect(calls[1]).toMatchObject({ ifMatch: '"7"', body: { body: 'base' } });
    await calls[1]!.respond(200, saved(N, { revision: 8 }));
    expect(store.getNote(S, N)!.save).toBe('saved');
    expect(store.hasUnsaved()).toBe(false);
    // It can happen again.
    store.edit(S, N, 'again');
    store.flush(S);
    await calls[2]!.respond(409, { reason: 'stale', revision: 12 });
    expect(store.getNote(S, N)!.save).toBe('conflict');
  });

  it('404 means gone: the text stays, and "save as new" creates a note with it', async () => {
    const { store, calls } = await withNote('');
    store.edit(S, N, 'keep this');
    store.flush(S);
    await calls[0]!.respond(404, {});
    expect(store.getNote(S, N)).toMatchObject({ save: 'gone', draft: 'keep this' });
    expect(store.hasUnsaved()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);

    const saving = store.saveAsNew(S, N);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[1]).toMatchObject({ method: 'POST', body: { title: `Title ${N}` } });
    await calls[1]!.respond(201, { note: { ...meta('n9'), body: '' } });
    await expect(saving).resolves.toEqual({ ok: true, id: 'n9' });
    expect(store.getNote(S, N)).toBeNull();
    expect(store.getSession(S).notes.map((n) => n.id)).toEqual(['n9']);
    expect(store.getCounts()[S]).toBe(1);
    expect(calls[2]).toMatchObject({
      method: 'PATCH',
      url: `/api/sessions/${S}/notes/n9`,
      body: { body: 'keep this' },
    });
    await calls[2]!.respond(200, saved('n9'));
    expect(store.getNote(S, 'n9')).toMatchObject({ save: 'saved', draft: 'keep this' });
    expect(store.hasUnsaved()).toBe(false);
  });

  it('"save as new" reports the session gone or the limit and keeps the note', async () => {
    const { store, calls } = await withNote('');
    store.edit(S, N, 'text');
    store.flush(S);
    await calls[0]!.respond(404, {});
    let saving = store.saveAsNew(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[1]!.respond(404, {});
    await expect(saving).resolves.toEqual({ ok: false, reason: 'gone' });
    saving = store.saveAsNew(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[2]!.respond(409, { reason: 'limit' });
    await expect(saving).resolves.toEqual({ ok: false, reason: 'limit' });
    expect(store.getNote(S, N)).toMatchObject({ save: 'gone', draft: 'text' });
  });

  it('a body opened after it was deleted elsewhere is gone, with nothing unsaved', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [meta(N, { bytes: 4 })] });
    store.ensureBody(S, N);
    await calls[1]!.respond(404, {});
    expect(store.getNote(S, N)).toMatchObject({ save: 'gone', draft: '', body: 'ready' });
    expect(store.hasUnsaved()).toBe(false);
  });

  it('never sends a body over the limit, and carries on once it fits', async () => {
    const { store, calls } = await withNote();
    const tooLong = 'é'.repeat(NOTE_BODY_MAX_BYTES / 2 + 1);
    store.edit(S, N, tooLong);
    expect(store.getNote(S, N)).toMatchObject({ save: 'tooLarge', draft: tooLong });
    await vi.advanceTimersByTimeAsync(60_000);
    store.flush(S);
    expect(calls).toHaveLength(0);
    expect(store.hasUnsaved()).toBe(true);
    store.edit(S, N, 'short');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
  });

  it('a body over the limit does not hold back a new title', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'x'.repeat(NOTE_BODY_MAX_BYTES + 1));
    store.rename(S, N, 'Plans');
    expect(calls[0]!.body).toEqual({ title: 'Plans' });
    await calls[0]!.respond(200, saved(N, { title: 'Plans' }));
    expect(store.getNote(S, N)!.save).toBe('tooLarge');
  });

  it('413 from the server holds the text until it changes', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'x');
    store.flush(S);
    await calls[0]!.respond(413, {});
    expect(store.getNote(S, N)).toMatchObject({ save: 'tooLarge', draft: 'x' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    store.edit(S, N, 'y');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
  });

  it.each([401, 403])(
    '%i asks to sign in again and keeps the text, without retrying',
    async (status) => {
      const { store, calls } = await withNote();
      store.edit(S, N, 'x');
      store.flush(S);
      await calls[0]!.respond(status, {});
      expect(store.getNote(S, N)).toMatchObject({ save: 'signIn', draft: 'x' });
      expect(store.hasUnsaved()).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls).toHaveLength(1);
    },
  );

  it('on the way out sends one keepalive request per note that fits', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [meta('n1'), meta('n2'), meta('n3')] });
    for (const id of ['n1', 'n2', 'n3']) {
      store.ensureBody(S, id);
      await calls.at(-1)!.respond(200, { note: { ...meta(id), body: '' } });
    }
    calls.length = 0;
    store.edit(S, 'n1', 'a'.repeat(EXIT_FLUSH_MAX_BYTES)); // over the budget alone
    store.edit(S, 'n2', 'small');
    store.flushOnExit();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      keepalive: true,
      url: `/api/sessions/${S}/notes/n2`,
      body: { body: 'small' },
    });
    // Page kept (back/forward cache): the answer is handled like any other.
    await calls[0]!.respond(200, saved('n2'));
    expect(store.getNote(S, 'n2')!.save).toBe('saved');
  });

  it('the budget on the way out covers all notes together', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [meta('n1'), meta('n2')] });
    for (const id of ['n1', 'n2']) {
      store.ensureBody(S, id);
      await calls.at(-1)!.respond(200, { note: { ...meta(id), body: '' } });
    }
    calls.length = 0;
    const half = 'a'.repeat(EXIT_FLUSH_MAX_BYTES / 2 + 1);
    store.edit(S, 'n1', half);
    store.edit(S, 'n2', half);
    store.flushOnExit();
    expect(calls).toHaveLength(1);
  });
});

describe('notes store: creating and deleting', () => {
  it('creates a note, ready to type in, and counts it', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [] });
    const creating = store.create(S, 'Note 1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[1]).toMatchObject({ method: 'POST', body: { title: 'Note 1' } });
    await calls[1]!.respond(201, { note: { ...meta('n5', { title: 'Note 1' }), body: '' } });
    await expect(creating).resolves.toEqual({ ok: true, id: 'n5' });
    expect(store.getNote(S, 'n5')).toMatchObject({ body: 'ready', draft: '', save: 'saved' });
    expect(store.getCounts()).toEqual({ [S]: 1 });
  });

  it('refuses at the limit before asking, and reports the limit from the server', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(200, {
      notes: Array.from({ length: NOTES_PER_SESSION_MAX }, (_, i) => meta(`n${i + 1}`)),
    });
    await expect(store.create(S, 'x')).resolves.toEqual({ ok: false, reason: 'limit' });
    expect(calls).toHaveLength(1);

    store.ensureList('s2');
    await calls[1]!.respond(200, { notes: [] });
    const creating = store.create('s2', 'x');
    await vi.advanceTimersByTimeAsync(0);
    await calls[2]!.respond(409, { reason: 'limit' });
    await expect(creating).resolves.toEqual({ ok: false, reason: 'limit' });
  });

  it('knows an empty note from its text or its stored size', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [meta('n1', { bytes: 0 }), meta('n2', { bytes: 5 })] });
    expect(store.isEmpty(S, 'n1')).toBe(true);
    expect(store.isEmpty(S, 'n2')).toBe(false);
    store.ensureBody(S, 'n2');
    await calls[1]!.respond(200, { note: { ...meta('n2'), body: 'hello' } });
    store.edit(S, 'n2', '');
    expect(store.isEmpty(S, 'n2')).toBe(true);
  });

  it('deletes a note, cancels its save, and treats one already gone as deleted', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'typed');
    const removing = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]).toMatchObject({ method: 'DELETE' });
    await calls[0]!.respond(404, {});
    await expect(removing).resolves.toEqual({ ok: true });
    expect(store.getNote(S, N)).toBeNull();
    expect(store.hasUnsaved()).toBe(false);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
  });

  it('a delete that fails keeps the note', async () => {
    const { store, calls } = await withNote();
    let removing = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[0]!.respond(500, {});
    await expect(removing).resolves.toEqual({ ok: false, reason: 'failed' });
    removing = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[1]!.respond(401, {});
    await expect(removing).resolves.toEqual({ ok: false, reason: 'signIn' });
    expect(store.getNote(S, N)).not.toBeNull();
  });

  it('an answer to a PATCH after its note was deleted changes nothing', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'typed');
    store.flush(S);
    const removing = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[1]!.respond(204);
    await removing;
    await calls[0]!.respond(404, {});
    expect(store.getNote(S, N)).toBeNull();
    expect(store.getSession(S).notes).toEqual([]);
  });
});

describe('notes store: deleting what changed elsewhere', () => {
  it('sends the revision it knows with a delete', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'typed');
    store.flush(S);
    await calls[0]!.respond(200, saved());
    const removing = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[1]).toMatchObject({ method: 'DELETE', ifMatch: '"2"' });
    await calls[1]!.respond(204);
    await expect(removing).resolves.toEqual({ ok: true });
  });

  it('a note that looked empty and is not: nothing deleted, its text loaded, then it asks', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl });
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [meta(N, { bytes: 0 })] });
    expect(store.isEmpty(S, N)).toBe(true);
    const removing = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[1]!.respond(409, { reason: 'stale', revision: 5 });
    await expect(removing).resolves.toEqual({ ok: false, reason: 'stale' });
    expect(store.getNote(S, N)!.body).toBe('loading');
    expect(calls[2]).toMatchObject({ method: 'GET', url: `/api/sessions/${S}/notes/${N}` });
    await calls[2]!.respond(200, {
      note: { ...meta(N, { revision: 5, bytes: 6 }), body: 'theirs' },
    });
    expect(store.getNote(S, N)).toMatchObject({ body: 'ready', draft: 'theirs', save: 'saved' });
    expect(store.isEmpty(S, N)).toBe(false);
    expect(store.getCounts()[S]).toBe(1);
    // Told to go on, it deletes the revision the user has now seen.
    const again = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[3]).toMatchObject({ method: 'DELETE', ifMatch: '"5"' });
    await calls[3]!.respond(204);
    await expect(again).resolves.toEqual({ ok: true });
  });

  it('refused with a loaded, saved note: the draft becomes the current text', async () => {
    const { store, calls } = await withNote('old');
    const removing = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[0]!.respond(409, { reason: 'stale', revision: 3 });
    await removing;
    await calls[1]!.respond(200, { note: { ...meta(N, { revision: 3 }), body: 'new' } });
    expect(store.getNote(S, N)).toMatchObject({ draft: 'new', save: 'saved' });
    expect(store.hasUnsaved()).toBe(false);
  });

  it('refused with text not saved yet: that text stays, as a conflict, and delete can go on', async () => {
    const { store, calls } = await withNote('old');
    store.edit(S, N, 'mine');
    const removing = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[0]!.respond(409, { reason: 'stale', revision: 3 });
    await expect(removing).resolves.toEqual({ ok: false, reason: 'stale' });
    expect(store.getNote(S, N)).toMatchObject({ draft: 'mine', save: 'conflict' });
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    const again = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[1]).toMatchObject({ method: 'DELETE', ifMatch: '"3"' });
    await calls[1]!.respond(204);
    await expect(again).resolves.toEqual({ ok: true });
  });

  it("refused because of this tab's own save in flight: its answer brings the revision", async () => {
    const { store, calls } = await withNote('old');
    store.edit(S, N, 'mine');
    store.flush(S);
    const removing = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[1]!.respond(409, { reason: 'stale', revision: 2 });
    await expect(removing).resolves.toEqual({ ok: false, reason: 'stale' });
    expect(store.getNote(S, N)!.save).toBe('saving');
    await calls[0]!.respond(200, saved());
    expect(store.getNote(S, N)).toMatchObject({ save: 'saved', draft: 'mine' });
    const again = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[2]).toMatchObject({ method: 'DELETE', ifMatch: '"2"' });
    await calls[2]!.respond(204);
    await expect(again).resolves.toEqual({ ok: true });
  });

  it('a failed reload after a refusal offers to try again', async () => {
    const { store, calls } = await withNote('old');
    const removing = store.remove(S, N);
    await vi.advanceTimersByTimeAsync(0);
    await calls[0]!.respond(409, { reason: 'stale', revision: 3 });
    await removing;
    await calls[1]!.fail();
    expect(store.getNote(S, N)!.body).toBe('failed');
    store.ensureBody(S, N);
    expect(calls).toHaveLength(3);
  });
});

describe('notes store: refreshing the counts', () => {
  const countsUrl = '/api/sessions/note-counts';

  it('takes the fresh numbers, and tells subscribers only when they changed', async () => {
    const { calls, impl } = fakeFetch();
    const counts = { a: 1 };
    const store = new NotesStore({ fetch: impl, counts });
    const listener = vi.fn();
    store.subscribe(listener);
    const same = store.refreshCounts();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]).toMatchObject({ method: 'GET', url: countsUrl });
    await calls[0]!.respond(200, { counts: { a: 1 } });
    await same;
    expect(store.getCounts()).toBe(counts);
    expect(listener).not.toHaveBeenCalled();

    const fresh = store.refreshCounts();
    await vi.advanceTimersByTimeAsync(0);
    await calls[1]!.respond(200, { counts: { a: 3, b: 2 } });
    await fresh;
    expect(store.getCounts()).toEqual({ a: 3, b: 2 });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('a failure leaves them as they are, silently', async () => {
    const { calls, impl } = fakeFetch();
    const counts = { a: 1 };
    const store = new NotesStore({ fetch: impl, counts });
    let refreshing = store.refreshCounts();
    await vi.advanceTimersByTimeAsync(0);
    await calls[0]!.fail();
    await expect(refreshing).resolves.toBeUndefined();
    refreshing = store.refreshCounts();
    await vi.advanceTimersByTimeAsync(0);
    await calls[1]!.respond(500, {});
    await refreshing;
    expect(store.getCounts()).toBe(counts);
  });

  it('an answer older than a change made here, or than a newer question, is dropped', async () => {
    const { store, calls } = await withNote();
    const older = store.refreshCounts();
    const creating = store.create(S, 'New');
    await vi.advanceTimersByTimeAsync(0);
    await calls[1]!.respond(201, { note: { ...meta('n9'), body: '' } });
    await creating;
    await calls[0]!.respond(200, { counts: { [S]: 1 } });
    await older;
    expect(store.getCounts()[S]).toBe(2);

    const first = store.refreshCounts();
    const second = store.refreshCounts();
    await vi.advanceTimersByTimeAsync(0);
    await calls[3]!.respond(200, { counts: { [S]: 7 } });
    await second;
    await calls[2]!.respond(200, { counts: { [S]: 4 } });
    await first;
    expect(store.getCounts()[S]).toBe(7);
  });

  it('seeds a first paint without telling anyone', async () => {
    const { store } = await withNote();
    const listener = vi.fn();
    store.subscribe(listener);
    store.seedCounts({ other: 4 });
    expect(store.getCounts()).toEqual({ other: 4 });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('notes store: dispose', () => {
  it('drops the text and counts, stops its timers and ignores late answers', async () => {
    const { store, calls } = await withNote('body', { [S]: 1 });
    store.edit(S, N, 'secret');
    store.flush(S);
    store.edit(S, N, 'secret, more');
    const refreshing = store.refreshCounts();
    store.dispose();
    expect(store.getNote(S, N)).toBeNull();
    expect(store.getCounts()).toEqual({});
    expect(store.hasUnsaved()).toBe(false);
    await calls[0]!.respond(200, saved());
    await calls[1]!.respond(200, { counts: { [S]: 1 } });
    await refreshing;
    expect(store.getCounts()).toEqual({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(2);
  });
});

describe('notes store: counts', () => {
  it('starts from the first paint and keeps its identity until a count changes', async () => {
    const counts = { [S]: 2, other: 1 };
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl, counts });
    expect(store.getCounts()).toBe(counts);
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [meta('n1'), meta('n2')] });
    expect(store.getCounts()).toBe(counts);
    store.ensureBody(S, 'n1');
    await calls[1]!.respond(200, { note: { ...meta('n1'), body: '' } });
    store.edit(S, 'n1', 'typing does not touch them');
    expect(store.getCounts()).toBe(counts);
    store.flush(S);
    await calls[2]!.respond(200, saved('n1'));
    expect(store.getCounts()).toBe(counts);

    const removing = store.remove(S, 'n1');
    await vi.advanceTimersByTimeAsync(0);
    await calls[3]!.respond(204);
    await removing;
    expect(store.getCounts()).toEqual({ [S]: 1, other: 1 });
    const after = store.getCounts();
    expect(store.getCounts()).toBe(after);
  });

  it('a list corrects a count, and a session without notes has no count', async () => {
    const { calls, impl } = fakeFetch();
    const store = new NotesStore({ fetch: impl, counts: { [S]: 3 } });
    store.ensureList(S);
    await calls[0]!.respond(200, { notes: [] });
    expect(store.getCounts()).toEqual({});
  });
});

describe('notes store: a session that leaves', () => {
  it('forgets its notes and count, cancels its timers and ignores late answers', async () => {
    const { store, calls } = await withNote('body', { [S]: 1 });
    store.edit(S, N, 'typed');
    store.forget(S);
    expect(store.getNote(S, N)).toBeNull();
    expect(store.getSession(S).list).toBe('idle');
    expect(store.getCounts()).toEqual({});
    expect(store.hasUnsaved()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(0);
  });

  it('cancels a pending retry too', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'typed');
    store.flush(S);
    await calls[0]!.fail();
    store.forget(S);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
  });

  it('ignores the answer to a PATCH in flight', async () => {
    const { store, calls } = await withNote();
    store.edit(S, N, 'typed');
    store.flush(S);
    store.forget(S);
    await calls[0]!.respond(200, saved());
    expect(store.getSession(S).notes).toEqual([]);
  });

  it('retains only the sessions still listed, counts included', async () => {
    const { store } = await withNote('body', { other: 2, kept: 1 });
    store.retainSessions(new Set(['kept', S]));
    expect(store.getCounts()).toEqual({ kept: 1, [S]: 1 });
    store.retainSessions(new Set(['kept']));
    expect(store.getNote(S, N)).toBeNull();
  });

  it('tells its subscribers', async () => {
    const { store } = await withNote();
    const listener = vi.fn();
    store.subscribe(listener);
    store.forget(S);
    expect(listener).toHaveBeenCalled();
  });
});

describe('note helpers', () => {
  it('names a new note with the lowest number not in use', () => {
    const name = (n: number) => `Note ${n}`;
    expect(lowestFreeNoteTitle([], name)).toBe('Note 1');
    expect(lowestFreeNoteTitle(['Note 1', 'Note 2'], name)).toBe('Note 3');
    expect(lowestFreeNoteTitle(['Note 1', 'Note 3', 'Plans'], name)).toBe('Note 2');
    expect(lowestFreeNoteTitle(['Nota 1'], (n) => `Nota ${n}`)).toBe('Nota 2');
  });

  it('counts a surrogate pair as one character', () => {
    expect(noteCharacters('')).toBe(0);
    expect(noteCharacters('abc')).toBe(3);
    expect(noteCharacters('a😀b')).toBe(3);
    expect(noteCharacters('é\n')).toBe(2);
  });
});
