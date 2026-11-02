import './server-guard.ts';
import { ErrorCode } from '@termavox/shared';
import { z } from 'zod';
import { authGate } from './auth/gate.ts';
import type { AuthRuntime } from './auth/runtime.ts';
import { parseIfMatch } from './layout-api.ts';
import { cleanNoteTitle, NOTE_BODY_MAX_BYTES, noteBodyBytes } from './notes/limits.ts';
import { readLimitedBody } from './read-limited-body.ts';
import {
  countNotesBySession,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
} from './repo/notes.ts';

type NotesDeps = Pick<AuthRuntime, 'auth' | 'db' | 'publicOrigin'>;

/** A title in a request: its limit is far below this, even with every character JSON-escaped. */
const MAX_CREATE_BYTES = 4 * 1024;
/** A maximal body after JSON escaping (a control character takes six bytes), plus the title. */
export const MAX_PATCH_BYTES = 6 * NOTE_BODY_MAX_BYTES + 4 * 1024;

const CreateNoteRequest = z.object({ title: z.string() });
const PatchNoteRequest = z.object({ title: z.string().optional(), body: z.string().optional() });

/**
 * `/api/sessions/:sessionId/notes[/:noteId]` (plan D-58): the plain-text notes of a session of
 * the signed-in user, in any state. All of them pass the auth gate (401 without a session, 403
 * while a password change or TOTP enrollment is pending); mutations also require `Origin` to be
 * TERMAVOX_PUBLIC_URL's origin (CSRF, plan §10.2), and a GET refuses a foreign `Origin` or
 * `Sec-Fetch-Site`. A session or note that does not exist or is someone else's gets the same 404.
 * A PATCH carries `If-Match: <revision>`; a stale one is answered with 409 and the current
 * revision. A DELETE may carry one too, with the same answer, and nothing is deleted then.
 * Titles and bodies are never logged.
 */
export async function getNotesResponse(
  deps: NotesDeps,
  request: Request,
  sessionId: string,
): Promise<Response> {
  const gate = await readGate(deps, request);
  if (gate instanceof Response) return gate;
  const notes = listNotes(deps.db, gate.userId, sessionId);
  return notes === null ? notFound() : reply(200, { notes });
}

/** `GET /api/sessions/note-counts`: how many notes each session of the user has. */
export async function getNoteCountsResponse(deps: NotesDeps, request: Request): Promise<Response> {
  const gate = await readGate(deps, request);
  if (gate instanceof Response) return gate;
  return reply(200, { counts: countNotesBySession(deps.db, gate.userId) });
}

export async function postNoteResponse(
  deps: NotesDeps,
  request: Request,
  sessionId: string,
): Promise<Response> {
  const gate = await mutationGate(deps, request);
  if (gate instanceof Response) return gate;
  const json = await readJson(request, MAX_CREATE_BYTES);
  if (json instanceof Response) return json;
  const parsed = CreateNoteRequest.safeParse(json);
  const title = parsed.success ? cleanNoteTitle(parsed.data.title) : null;
  if (title === null) return invalid('invalid title');
  const result = createNote(deps.db, gate.userId, sessionId, title);
  if (result.outcome === 'not-found') return notFound();
  if (result.outcome === 'limit') {
    return reply(409, {
      code: ErrorCode.Conflict,
      message: 'too many notes in this session',
      reason: 'limit',
    });
  }
  return reply(201, { note: result.note });
}

export async function getNoteResponse(
  deps: NotesDeps,
  request: Request,
  sessionId: string,
  noteId: string,
): Promise<Response> {
  const gate = await readGate(deps, request);
  if (gate instanceof Response) return gate;
  const note = getNote(deps.db, gate.userId, sessionId, noteId);
  return note === null ? notFound() : reply(200, { note });
}

export async function patchNoteResponse(
  deps: NotesDeps,
  request: Request,
  sessionId: string,
  noteId: string,
): Promise<Response> {
  const gate = await mutationGate(deps, request);
  if (gate instanceof Response) return gate;
  const expected = parseIfMatch(request.headers.get('if-match'));
  if (expected === null) {
    return reply(428, { code: ErrorCode.BadRequest, message: 'If-Match: <revision> required' });
  }
  const json = await readJson(request, MAX_PATCH_BYTES);
  if (json instanceof Response) return json;
  const parsed = PatchNoteRequest.safeParse(json);
  if (!parsed.success) return invalid('invalid note');
  const { title: rawTitle, body } = parsed.data;
  if (rawTitle === undefined && body === undefined) return invalid('nothing to change');
  const changes: { title?: string; body?: string } = {};
  if (rawTitle !== undefined) {
    const title = cleanNoteTitle(rawTitle);
    if (title === null) return invalid('invalid title');
    changes.title = title;
  }
  if (body !== undefined) {
    if (noteBodyBytes(body) > NOTE_BODY_MAX_BYTES) return tooLarge();
    changes.body = body;
  }
  const result = updateNote(deps.db, gate.userId, sessionId, noteId, changes, expected);
  if (result.outcome === 'not-found') return notFound();
  if (result.outcome === 'stale') return stale(result.revision);
  return reply(200, { note: result.note });
}

export async function deleteNoteResponse(
  deps: NotesDeps,
  request: Request,
  sessionId: string,
  noteId: string,
): Promise<Response> {
  const gate = await mutationGate(deps, request);
  if (gate instanceof Response) return gate;
  const ifMatch = request.headers.get('if-match');
  const expected = ifMatch === null ? undefined : parseIfMatch(ifMatch);
  // A revision that cannot be read is not permission to delete whatever is there.
  if (expected === null) {
    return reply(428, { code: ErrorCode.BadRequest, message: 'If-Match: <revision> unreadable' });
  }
  const result = deleteNote(deps.db, gate.userId, sessionId, noteId, expected);
  if (result.outcome === 'not-found') return notFound();
  if (result.outcome === 'stale') return stale(result.revision);
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/** A browser's same-origin GET sends no `Origin`, so a GET only refuses a foreign one. */
async function readGate(deps: NotesDeps, request: Request): Promise<{ userId: string } | Response> {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (
    (origin !== null && origin !== deps.publicOrigin) ||
    (site !== null && site !== 'same-origin')
  ) {
    return originRefused();
  }
  return gateOrReply(deps, request);
}

async function mutationGate(
  deps: NotesDeps,
  request: Request,
): Promise<{ userId: string } | Response> {
  if (request.headers.get('origin') !== deps.publicOrigin) return originRefused();
  return gateOrReply(deps, request);
}

async function gateOrReply(
  deps: NotesDeps,
  request: Request,
): Promise<{ userId: string } | Response> {
  const gate = await authGate(deps, request.headers);
  if (gate.ok) return { userId: gate.user.id };
  if (gate.reason === 'password-change' || gate.reason === 'totp-enrollment') {
    return reply(403, { code: ErrorCode.Forbidden, message: `pending ${gate.reason}` });
  }
  return reply(401, { code: ErrorCode.Unauthenticated, message: 'authentication required' });
}

/** The request's JSON, or the 413 / 400 answer. */
async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readLimitedBody(request, maxBytes);
  if (text === null) return tooLarge();
  try {
    return JSON.parse(text);
  } catch {
    return invalid('malformed JSON');
  }
}

function stale(revision: number): Response {
  return reply(409, {
    code: ErrorCode.Conflict,
    message: 'note changed',
    reason: 'stale',
    revision,
  });
}

function originRefused(): Response {
  return reply(403, { code: ErrorCode.Forbidden, message: 'origin not allowed' });
}

function notFound(): Response {
  return reply(404, { code: ErrorCode.NotFound, message: 'not found' });
}

function invalid(message: string): Response {
  return reply(400, { code: ErrorCode.BadRequest, message });
}

function tooLarge(): Response {
  return reply(413, { code: ErrorCode.BadRequest, message: 'note too large' });
}

function reply(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
