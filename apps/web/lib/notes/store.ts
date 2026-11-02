import {
  cleanNoteTitle,
  NOTE_BODY_MAX_BYTES,
  NOTES_PER_SESSION_MAX,
  noteBodyBytes,
} from './limits.ts';
import type { Note, NoteMeta } from './types.ts';

/**
 * The notes of the sessions this browser tab shows (plan D-58): per session the list of notes, per
 * note the draft and how saving it goes. Saves live here, not in a component, so they survive a
 * pane unmounting (another workspace tab in front). Everything is in memory: nothing about notes
 * goes to browser storage or a log. Framework-free (the `useSyncExternalStore` shape); snapshots
 * are immutable and keep their identity until they change.
 */

/** How long typing must stop before a note is saved. */
export const SAVE_DEBOUNCE_MS = 1_000;
/** Waits between attempts after a network failure or a 5xx; the last one repeats. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000] as const;
/** What fits in one `keepalive` request when the page goes away (browsers allow 64 KiB in all). */
export const EXIT_FLUSH_MAX_BYTES = 60 * 1024;

export type ListState = 'idle' | 'loading' | 'ready' | 'error';
export type BodyState = 'idle' | 'loading' | 'ready' | 'failed';
/**
 * `pending`: changed, waiting for the debounce. `retrying`: not saved, trying again. `conflict`:
 * the note changed in another window. `gone`: deleted elsewhere. `tooLarge`: over the limit, not
 * sent. `signIn`: the sign-in has ended. The last four hold the text until something changes.
 */
export type SaveState =
  | 'saved'
  | 'pending'
  | 'saving'
  | 'retrying'
  | 'conflict'
  | 'gone'
  | 'tooLarge'
  | 'signIn';

export interface SessionNotes {
  list: ListState;
  /** The list failed because the sign-in has ended. */
  listSignIn: boolean;
  notes: readonly NoteMeta[];
}

export interface NoteState {
  id: string;
  title: string;
  /** When the server last changed it, epoch ms. */
  updatedAt: number;
  body: BodyState;
  /** The body failed to load because the sign-in has ended. */
  bodySignIn: boolean;
  /** The text on screen. */
  draft: string;
  /** UTF-8 size of the draft (of the stored body until it is loaded). */
  bytes: number;
  save: SaveState;
  /** The server refused a new title; the old one is back. */
  titleRefused: boolean;
}

export type CreateResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'limit' | 'gone' | 'signIn' | 'failed' };
/** `stale`: it changed elsewhere, so nothing was deleted and its current text is coming. */
export type RemoveResult = { ok: true } | { ok: false; reason: 'stale' | 'signIn' | 'failed' };

export interface NotesStoreOptions {
  /** Session id → how many notes, from the first paint. */
  counts?: Readonly<Record<string, number>>;
  fetch?: typeof fetch;
}

interface Entry {
  meta: NoteMeta;
  body: BodyState;
  bodySignIn: boolean;
  draft: string;
  draftBytes: number;
  /** The body and title the server holds, as far as this tab knows. */
  savedBody: string;
  savedTitle: string;
  /** A title not yet saved. */
  titlePending: string | null;
  /** "Keep mine": the body goes out even if it equals the last one seen here. */
  forceBody: boolean;
  save: SaveState;
  titleRefused: boolean;
  inFlight: boolean;
  /** Another PATCH follows the one in flight. */
  queued: boolean;
  debounce: ReturnType<typeof setTimeout> | null;
  retry: ReturnType<typeof setTimeout> | null;
  attempt: number;
  conflictRevision: number | null;
  view: NoteState | null;
}

interface SessionEntry {
  list: ListState;
  listSignIn: boolean;
  entries: Map<string, Entry>;
  snapshot: SessionNotes | null;
}

const EMPTY_SESSION: SessionNotes = { list: 'idle', listSignIn: false, notes: [] };

function byCreation(a: Entry, b: Entry): number {
  return (
    a.meta.createdAt - b.meta.createdAt ||
    (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0)
  );
}

function toEntry(meta: NoteMeta, body: string | null): Entry {
  return {
    meta,
    body: body === null ? 'idle' : 'ready',
    bodySignIn: false,
    draft: body ?? '',
    draftBytes: body === null ? meta.bytes : noteBodyBytes(body),
    savedBody: body ?? '',
    savedTitle: meta.title,
    titlePending: null,
    forceBody: false,
    save: 'saved',
    titleRefused: false,
    inFlight: false,
    queued: false,
    debounce: null,
    retry: null,
    attempt: 0,
    conflictRevision: null,
    view: null,
  };
}

function metaOf(note: NoteMeta): NoteMeta {
  return {
    id: note.id,
    title: note.title,
    revision: note.revision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    bytes: note.bytes,
  };
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export class NotesStore {
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #listeners = new Set<() => void>();
  readonly #fetch: typeof fetch;
  #counts: Readonly<Record<string, number>>;
  /** Moves with every change to the counts: an answer that was asked for before one is old. */
  #countsSeq = 0;

  constructor(options: NotesStoreOptions = {}) {
    this.#counts = options.counts ?? {};
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Session id → how many notes (only sessions that have any); changes only with a count. */
  readonly getCounts = (): Readonly<Record<string, number>> => this.#counts;

  getSession(sessionId: string): SessionNotes {
    const session = this.#sessions.get(sessionId);
    if (!session) return EMPTY_SESSION;
    session.snapshot ??= {
      list: session.list,
      listSignIn: session.listSignIn,
      notes: [...session.entries.values()].map((entry) => entry.meta),
    };
    return session.snapshot;
  }

  getNote(sessionId: string, noteId: string): NoteState | null {
    const entry = this.#sessions.get(sessionId)?.entries.get(noteId);
    if (!entry) return null;
    entry.view ??= {
      id: entry.meta.id,
      title: entry.meta.title,
      updatedAt: entry.meta.updatedAt,
      body: entry.body,
      bodySignIn: entry.bodySignIn,
      draft: entry.draft,
      bytes: entry.draftBytes,
      save: entry.save,
      titleRefused: entry.titleRefused,
    };
    return entry.view;
  }

  /** The note has no text: its × deletes at once. */
  isEmpty(sessionId: string, noteId: string): boolean {
    const entry = this.#sessions.get(sessionId)?.entries.get(noteId);
    if (!entry) return true;
    return entry.body === 'ready' ? entry.draft === '' : entry.meta.bytes === 0;
  }

  /** Something on screen is not on the server: leaving the page asks first. */
  readonly hasUnsaved = (): boolean => {
    for (const session of this.#sessions.values()) {
      for (const entry of session.entries.values()) {
        if (entry.inFlight || entry.titlePending !== null || entry.forceBody) return true;
        if (entry.save === 'gone') {
          if (entry.draft !== '') return true;
        } else if (entry.body === 'ready' && entry.draft !== entry.savedBody) {
          return true;
        }
      }
    }
    return false;
  };

  /** Fetches the session's list unless it has it or is fetching it (a failed one tries again). */
  ensureList(sessionId: string): void {
    const session = this.#session(sessionId);
    if (session.list === 'loading' || session.list === 'ready') return;
    session.list = 'loading';
    session.listSignIn = false;
    session.snapshot = null;
    this.#emit();
    void this.#loadList(sessionId, session);
  }

  /** Fetches a note's body unless it has it or is fetching it (a failed one tries again). */
  ensureBody(sessionId: string, noteId: string): void {
    const session = this.#sessions.get(sessionId);
    const entry = session?.entries.get(noteId);
    if (!session || !entry || entry.body === 'loading' || entry.body === 'ready') return;
    entry.body = 'loading';
    entry.bodySignIn = false;
    this.#publish(entry);
    void this.#loadBody(sessionId, session, entry);
  }

  /** The user changed the text. */
  edit(sessionId: string, noteId: string, text: string): void {
    const entry = this.#sessions.get(sessionId)?.entries.get(noteId);
    if (entry?.body !== 'ready' || text === entry.draft) return;
    entry.draft = text;
    entry.draftBytes = noteBodyBytes(text);
    if (entry.save === 'conflict' || entry.save === 'gone') {
      this.#publish(entry);
      return;
    }
    this.#clearTimer(entry, 'debounce');
    if (entry.draftBytes > NOTE_BODY_MAX_BYTES) {
      // Stays on screen; nothing goes out until it fits again.
      this.#clearTimer(entry, 'retry');
      entry.attempt = 0;
      entry.save = 'tooLarge';
    } else {
      if (entry.save !== 'retrying') entry.save = 'pending';
      this.#schedule(sessionId, entry);
    }
    this.#publish(entry);
  }

  /**
   * Saves a new title at once. `invalid` (empty or too long) changes nothing. A refusal by the
   * server puts the old title back and sets `titleRefused`.
   */
  rename(sessionId: string, noteId: string, raw: string): 'ok' | 'invalid' {
    const entry = this.#sessions.get(sessionId)?.entries.get(noteId);
    if (!entry) return 'ok';
    const title = cleanNoteTitle(raw);
    if (title === null) return 'invalid';
    entry.titleRefused = false;
    if (title === entry.meta.title) {
      this.#publish(entry);
      return 'ok';
    }
    entry.titlePending = title === entry.savedTitle ? null : title;
    entry.meta = { ...entry.meta, title };
    this.#metaChanged(sessionId, entry);
    if (entry.save === 'saved' || entry.save === 'signIn') entry.save = 'pending';
    this.#trigger(sessionId, entry);
    return 'ok';
  }

  async create(sessionId: string, title: string): Promise<CreateResult> {
    const session = this.#session(sessionId);
    if (session.list === 'ready' && session.entries.size >= NOTES_PER_SESSION_MAX) {
      return { ok: false, reason: 'limit' };
    }
    const created = await this.#post(sessionId, title);
    if (!created.ok) return created;
    if (this.#sessions.get(sessionId) !== session) return { ok: false, reason: 'gone' };
    this.#insert(sessionId, session, toEntry(metaOf(created.note), created.note.body ?? ''));
    return { ok: true, id: created.note.id };
  }

  /**
   * Deletes a note at the revision known here (one already gone from the server is simply dropped
   * here). If it changed elsewhere nothing is deleted: its current text is loaded, or, with text
   * here not yet saved, it becomes a conflict, and the user decides with that in view.
   */
  async remove(sessionId: string, noteId: string): Promise<RemoveResult> {
    const session = this.#sessions.get(sessionId);
    const entry = session?.entries.get(noteId);
    if (!session || !entry) return { ok: true };
    let response: Response;
    try {
      response = await this.#fetch(this.#noteUrl(sessionId, noteId), {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'if-match': `"${entry.conflictRevision ?? entry.meta.revision}"` },
      });
    } catch {
      return { ok: false, reason: 'failed' };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'signIn' };
    if (response.status === 409) {
      const revision = (await readJson<{ revision?: number }>(response))?.revision ?? null;
      if (session.entries.get(noteId) === entry) {
        this.#deleteRefused(sessionId, entry, revision);
      }
      return { ok: false, reason: 'stale' };
    }
    if (!response.ok && response.status !== 404) return { ok: false, reason: 'failed' };
    if (session.entries.get(noteId) !== entry) return { ok: true };
    this.#cancel(entry);
    session.entries.delete(noteId);
    session.snapshot = null;
    this.#setCount(sessionId, session.entries.size);
    this.#emit();
    return { ok: true };
  }

  /** Saves what is waiting for this session (or this note) now instead of after the debounce. */
  flush(sessionId: string, noteId?: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    for (const entry of session.entries.values()) {
      if (noteId !== undefined && entry.meta.id !== noteId) continue;
      if (entry.save === 'pending' || entry.save === 'retrying') this.#trigger(sessionId, entry);
    }
  }

  /** The page went to the background. */
  flushAll(): void {
    for (const sessionId of this.#sessions.keys()) this.flush(sessionId);
  }

  /**
   * The page is going away: one `keepalive` request per note that fits, within what browsers
   * allow in all. What does not fit waited on the leave guard's question.
   */
  flushOnExit(): void {
    let room = EXIT_FLUSH_MAX_BYTES;
    for (const [sessionId, session] of this.#sessions) {
      for (const entry of session.entries.values()) {
        if (entry.inFlight || (entry.save !== 'pending' && entry.save !== 'retrying')) continue;
        const payload = this.#payload(entry);
        if (!payload) continue;
        const size = noteBodyBytes(JSON.stringify(payload));
        if (size >= room) continue;
        room -= size;
        void this.#send(sessionId, entry, payload, true);
      }
    }
  }

  /** The network came back: whatever was waiting to try again tries now. */
  online(): void {
    for (const [sessionId, session] of this.#sessions) {
      for (const entry of session.entries.values()) {
        if (entry.save === 'retrying') this.#trigger(sessionId, entry);
      }
    }
  }

  /** The note changed in another window: replace the draft with the server's version. */
  async loadOther(sessionId: string, noteId: string): Promise<boolean> {
    const session = this.#sessions.get(sessionId);
    const entry = session?.entries.get(noteId);
    if (!session || !entry) return false;
    let response: Response;
    try {
      response = await this.#fetch(this.#noteUrl(sessionId, noteId), { cache: 'no-store' });
    } catch {
      return false;
    }
    if (session.entries.get(noteId) !== entry) return false;
    if (response.status === 404) {
      this.#gone(entry);
      return true;
    }
    const json = response.ok ? await readJson<{ note: Note }>(response) : null;
    if (!json?.note || session.entries.get(noteId) !== entry) return false;
    this.#cancel(entry);
    entry.meta = metaOf(json.note);
    entry.draft = json.note.body;
    entry.draftBytes = noteBodyBytes(json.note.body);
    entry.savedBody = json.note.body;
    entry.savedTitle = json.note.title;
    entry.titlePending = null;
    entry.forceBody = false;
    entry.conflictRevision = null;
    entry.attempt = 0;
    entry.save = 'saved';
    this.#metaChanged(sessionId, entry);
    this.#publish(entry);
    return true;
  }

  /** The note changed in another window: adopt its revision and save this text over it. */
  keepMine(sessionId: string, noteId: string): void {
    const entry = this.#sessions.get(sessionId)?.entries.get(noteId);
    if (entry?.save !== 'conflict' || entry.conflictRevision === null) return;
    entry.meta = { ...entry.meta, revision: entry.conflictRevision };
    this.#metaChanged(sessionId, entry);
    entry.conflictRevision = null;
    entry.forceBody = true;
    entry.attempt = 0;
    entry.save = 'pending';
    this.#trigger(sessionId, entry);
  }

  /** The note was deleted elsewhere: a new note takes over its title and text. */
  async saveAsNew(sessionId: string, noteId: string): Promise<CreateResult> {
    const session = this.#sessions.get(sessionId);
    const entry = session?.entries.get(noteId);
    if (!session || !entry) return { ok: false, reason: 'gone' };
    const created = await this.#post(sessionId, entry.meta.title);
    if (!created.ok) return created;
    if (session.entries.get(noteId) !== entry) return { ok: false, reason: 'gone' };
    const next = toEntry(metaOf(created.note), '');
    next.draft = entry.draft;
    next.draftBytes = entry.draftBytes;
    next.save = 'pending';
    this.#cancel(entry);
    session.entries.delete(noteId);
    this.#insert(sessionId, session, next);
    this.#trigger(sessionId, next);
    return { ok: true, id: created.note.id };
  }

  /** The counts from the server, which other windows' notes reach. A failure changes nothing. */
  async refreshCounts(): Promise<void> {
    this.#countsSeq += 1;
    const seq = this.#countsSeq;
    let counts: Record<string, number> | null = null;
    try {
      const response = await this.#fetch('/api/sessions/note-counts', { cache: 'no-store' });
      if (response.ok) {
        counts = (await readJson<{ counts: Record<string, number> }>(response))?.counts ?? null;
      }
    } catch {
      // Silently as they were.
    }
    if (!counts || typeof counts !== 'object' || seq !== this.#countsSeq) return;
    if (this.#replaceCounts(counts)) this.#emit();
  }

  /** The first paint of a shell mounting on this store. Nobody is listening yet. */
  seedCounts(counts: Readonly<Record<string, number>>): void {
    this.#replaceCounts(counts);
  }

  /** Forgets everything: nothing of it runs or answers any more. */
  dispose(): void {
    for (const session of this.#sessions.values()) {
      for (const entry of session.entries.values()) this.#cancel(entry);
    }
    this.#sessions.clear();
    this.#replaceCounts({});
    this.#countsSeq += 1;
    this.#emit();
  }

  /** The session left: its notes go with it, and nothing of it runs any more. */
  forget(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session) {
      for (const entry of session.entries.values()) this.#cancel(entry);
      this.#sessions.delete(sessionId);
    }
    const counts = this.#counts;
    this.#setCount(sessionId, 0);
    if (session || counts !== this.#counts) this.#emit();
  }

  /** Forgets every session not in `sessionIds` (the live list). */
  retainSessions(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of [...this.#sessions.keys(), ...Object.keys(this.#counts)]) {
      if (!sessionIds.has(sessionId)) this.forget(sessionId);
    }
  }

  #session(sessionId: string): SessionEntry {
    let session = this.#sessions.get(sessionId);
    if (!session) {
      session = { list: 'idle', listSignIn: false, entries: new Map(), snapshot: null };
      this.#sessions.set(sessionId, session);
    }
    return session;
  }

  #listUrl(sessionId: string): string {
    return `/api/sessions/${encodeURIComponent(sessionId)}/notes`;
  }

  #noteUrl(sessionId: string, noteId: string): string {
    return `${this.#listUrl(sessionId)}/${encodeURIComponent(noteId)}`;
  }

  async #loadList(sessionId: string, session: SessionEntry): Promise<void> {
    let notes: NoteMeta[] | null = null;
    let signIn = false;
    try {
      const response = await this.#fetch(this.#listUrl(sessionId), { cache: 'no-store' });
      signIn = response.status === 401 || response.status === 403;
      if (response.ok) notes = (await readJson<{ notes: NoteMeta[] }>(response))?.notes ?? null;
    } catch {
      // Stays an error: the view offers to try again.
    }
    if (this.#sessions.get(sessionId) !== session) return;
    session.snapshot = null;
    if (!notes) {
      session.list = 'error';
      session.listSignIn = signIn;
      this.#emit();
      return;
    }
    session.list = 'ready';
    // A note created here while the list was on its way stays.
    for (const meta of notes) {
      const entry = session.entries.get(meta.id);
      if (!entry) session.entries.set(meta.id, toEntry(metaOf(meta), null));
      else if (entry.body !== 'ready') {
        entry.meta = metaOf(meta);
        entry.savedTitle = meta.title;
        entry.draftBytes = meta.bytes;
        entry.view = null;
      }
    }
    this.#sort(session);
    this.#setCount(sessionId, session.entries.size);
    this.#emit();
  }

  async #loadBody(sessionId: string, session: SessionEntry, entry: Entry): Promise<void> {
    let note: Note | null = null;
    let status = 0;
    try {
      const response = await this.#fetch(this.#noteUrl(sessionId, entry.meta.id), {
        cache: 'no-store',
      });
      status = response.status;
      if (response.ok) note = (await readJson<{ note: Note }>(response))?.note ?? null;
    } catch {
      // Stays failed: the view offers to try again.
    }
    if (session.entries.get(entry.meta.id) !== entry) return;
    if (status === 404) {
      entry.body = 'ready';
      this.#gone(entry);
      return;
    }
    if (!note) {
      entry.body = 'failed';
      entry.bodySignIn = status === 401 || status === 403;
      this.#publish(entry);
      return;
    }
    entry.body = 'ready';
    entry.draft = note.body;
    entry.draftBytes = noteBodyBytes(note.body);
    entry.savedBody = note.body;
    // A rename on its way keeps showing.
    entry.savedTitle = note.title;
    entry.meta = { ...metaOf(note), title: entry.titlePending ?? note.title };
    this.#metaChanged(sessionId, entry);
    this.#publish(entry);
  }

  async #post(
    sessionId: string,
    title: string,
  ): Promise<
    | { ok: true; note: NoteMeta & { body?: string } }
    | { ok: false; reason: 'limit' | 'gone' | 'signIn' | 'failed' }
  > {
    let response: Response;
    try {
      response = await this.#fetch(this.#listUrl(sessionId), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
    } catch {
      return { ok: false, reason: 'failed' };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'signIn' };
    if (response.status === 404) return { ok: false, reason: 'gone' };
    if (response.status === 409) return { ok: false, reason: 'limit' };
    const json = response.ok
      ? await readJson<{ note: NoteMeta & { body?: string } }>(response)
      : null;
    return json?.note ? { ok: true, note: json.note } : { ok: false, reason: 'failed' };
  }

  #insert(sessionId: string, session: SessionEntry, entry: Entry): void {
    session.entries.set(entry.meta.id, entry);
    this.#sort(session);
    session.snapshot = null;
    this.#setCount(sessionId, session.entries.size);
    this.#emit();
  }

  #sort(session: SessionEntry): void {
    const sorted = [...session.entries.values()].sort(byCreation);
    session.entries = new Map(sorted.map((entry) => [entry.meta.id, entry]));
  }

  #schedule(sessionId: string, entry: Entry): void {
    entry.debounce = setTimeout(() => {
      entry.debounce = null;
      this.#trigger(sessionId, entry);
    }, SAVE_DEBOUNCE_MS);
  }

  /** Saves now, or right after the PATCH in flight. */
  #trigger(sessionId: string, entry: Entry): void {
    this.#clearTimer(entry, 'debounce');
    this.#clearTimer(entry, 'retry');
    // Held until the user answers; a change meanwhile goes out with the answer.
    if (entry.save === 'conflict' || entry.save === 'gone') {
      this.#publish(entry);
      return;
    }
    if (entry.inFlight) {
      entry.queued = true;
      this.#publish(entry);
      return;
    }
    const payload = this.#payload(entry);
    if (!payload) {
      entry.save = entry.draftBytes > NOTE_BODY_MAX_BYTES ? 'tooLarge' : 'saved';
      entry.attempt = 0;
      this.#publish(entry);
      return;
    }
    void this.#send(sessionId, entry, payload, false);
  }

  /** Only what changed; a body over the limit stays home. */
  #payload(entry: Entry): { title?: string; body?: string } | null {
    const payload: { title?: string; body?: string } = {};
    if (entry.titlePending !== null) payload.title = entry.titlePending;
    const bodyChanged =
      entry.body === 'ready' && (entry.forceBody || entry.draft !== entry.savedBody);
    if (bodyChanged && entry.draftBytes <= NOTE_BODY_MAX_BYTES) payload.body = entry.draft;
    return payload.title === undefined && payload.body === undefined ? null : payload;
  }

  async #send(
    sessionId: string,
    entry: Entry,
    payload: { title?: string; body?: string },
    keepalive: boolean,
  ): Promise<void> {
    this.#clearTimer(entry, 'debounce');
    this.#clearTimer(entry, 'retry');
    entry.inFlight = true;
    if (entry.save !== 'retrying') entry.save = 'saving';
    this.#publish(entry);
    let response: Response | null = null;
    let meta: NoteMeta | null = null;
    let revision: number | null = null;
    try {
      response = await this.#fetch(this.#noteUrl(sessionId, entry.meta.id), {
        method: 'PATCH',
        credentials: 'same-origin',
        keepalive,
        headers: { 'content-type': 'application/json', 'if-match': `"${entry.meta.revision}"` },
        body: JSON.stringify(payload),
      });
      if (response.ok) meta = (await readJson<{ note: NoteMeta }>(response))?.note ?? null;
      else if (response.status === 409) {
        revision = (await readJson<{ revision?: number }>(response))?.revision ?? null;
      }
    } catch {
      response = null;
    }
    // Forgotten or deleted meanwhile: nothing here to update.
    if (this.#sessions.get(sessionId)?.entries.get(entry.meta.id) !== entry) return;
    entry.inFlight = false;
    if (response?.ok && meta) this.#saved(sessionId, entry, payload, meta);
    else if (response?.status === 409 && revision !== null) this.#stale(entry, revision);
    else if (response?.status === 404) this.#gone(entry);
    else if (response?.status === 413) this.#tooLarge(entry);
    else if (response?.status === 401 || response?.status === 403) this.#signIn(entry);
    else if (response?.status === 400 && payload.title !== undefined) {
      this.#titleRefused(sessionId, entry);
    } else this.#retryLater(sessionId, entry);
  }

  #saved(
    sessionId: string,
    entry: Entry,
    payload: { title?: string; body?: string },
    note: NoteMeta,
  ): void {
    if (payload.body !== undefined) {
      entry.savedBody = payload.body;
      entry.forceBody = false;
    }
    if (payload.title !== undefined) entry.savedTitle = note.title;
    if (entry.titlePending === payload.title) entry.titlePending = null;
    // A title typed while this was in flight keeps showing, and goes out next.
    entry.meta = { ...metaOf(note), title: entry.titlePending ?? note.title };
    entry.attempt = 0;
    this.#metaChanged(sessionId, entry);
    this.#settle(sessionId, entry);
  }

  /** After a successful PATCH: the queued one goes now; otherwise the debounce or nothing. */
  #settle(sessionId: string, entry: Entry): void {
    if (entry.queued) {
      entry.queued = false;
      entry.save = 'pending';
      this.#trigger(sessionId, entry);
      return;
    }
    const waiting = entry.debounce !== null;
    if (entry.draftBytes > NOTE_BODY_MAX_BYTES) entry.save = 'tooLarge';
    else if (waiting || this.#payload(entry)) entry.save = 'pending';
    else entry.save = 'saved';
    if (!waiting && entry.save === 'pending') {
      this.#trigger(sessionId, entry);
      return;
    }
    this.#publish(entry);
  }

  /** A delete was refused because the note changed elsewhere. */
  #deleteRefused(sessionId: string, entry: Entry, revision: number | null): void {
    // Maybe this tab's own save: its answer brings the revision, and the next try goes through.
    if (entry.inFlight) return;
    const unsaved =
      entry.titlePending !== null ||
      entry.forceBody ||
      (entry.body === 'ready' && entry.draft !== entry.savedBody);
    if (unsaved) {
      if (revision !== null) this.#stale(entry, revision);
      return;
    }
    entry.body = 'idle';
    this.ensureBody(sessionId, entry.meta.id);
  }

  #stale(entry: Entry, revision: number): void {
    this.#hold(entry, 'conflict');
    entry.conflictRevision = revision;
    this.#publish(entry);
  }

  #gone(entry: Entry): void {
    this.#hold(entry, 'gone');
    this.#publish(entry);
  }

  #tooLarge(entry: Entry): void {
    this.#hold(entry, 'tooLarge');
    this.#publish(entry);
  }

  #signIn(entry: Entry): void {
    this.#hold(entry, 'signIn');
    this.#publish(entry);
  }

  #hold(entry: Entry, save: SaveState): void {
    this.#clearTimer(entry, 'debounce');
    this.#clearTimer(entry, 'retry');
    entry.queued = false;
    entry.attempt = 0;
    entry.save = save;
  }

  #titleRefused(sessionId: string, entry: Entry): void {
    entry.titlePending = null;
    entry.titleRefused = true;
    entry.meta = { ...entry.meta, title: entry.savedTitle };
    this.#metaChanged(sessionId, entry);
    this.#settle(sessionId, entry);
  }

  #retryLater(sessionId: string, entry: Entry): void {
    const delay =
      RETRY_DELAYS_MS[Math.min(entry.attempt, RETRY_DELAYS_MS.length - 1)] ?? SAVE_DEBOUNCE_MS;
    entry.attempt += 1;
    entry.queued = false;
    entry.save = 'retrying';
    this.#clearTimer(entry, 'retry');
    entry.retry = setTimeout(() => {
      entry.retry = null;
      this.#trigger(sessionId, entry);
    }, delay);
    this.#publish(entry);
  }

  #clearTimer(entry: Entry, timer: 'debounce' | 'retry'): void {
    const handle = entry[timer];
    if (handle !== null) clearTimeout(handle);
    entry[timer] = null;
  }

  #cancel(entry: Entry): void {
    this.#clearTimer(entry, 'debounce');
    this.#clearTimer(entry, 'retry');
    entry.queued = false;
  }

  #metaChanged(sessionId: string, entry: Entry): void {
    entry.view = null;
    const session = this.#sessions.get(sessionId);
    if (session) session.snapshot = null;
  }

  #publish(entry: Entry): void {
    entry.view = null;
    this.#emit();
  }

  #replaceCounts(counts: Readonly<Record<string, number>>): boolean {
    const before = Object.keys(this.#counts);
    const after = Object.keys(counts);
    if (before.length === after.length && after.every((k) => this.#counts[k] === counts[k])) {
      return false;
    }
    this.#counts = counts;
    this.#countsSeq += 1;
    return true;
  }

  #setCount(sessionId: string, count: number): void {
    if ((this.#counts[sessionId] ?? 0) === count) return;
    this.#countsSeq += 1;
    const { [sessionId]: _dropped, ...rest } = this.#counts;
    this.#counts = count > 0 ? { ...rest, [sessionId]: count } : rest;
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** Characters as a person counts them closer than UTF-16 does: a surrogate pair is one. */
export function noteCharacters(text: string): number {
  let count = text.length;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) count -= 1;
  }
  return count;
}
