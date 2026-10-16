import './server-guard.ts';
import { WorkspaceLayout } from '@termdock/protocol';
import { ErrorCode } from '@termdock/shared';
import { authGate } from './auth/gate.ts';
import type { AuthRuntime } from './auth/runtime.ts';
import { getLayout, saveLayout } from './repo/layouts.ts';

type LayoutDeps = Pick<AuthRuntime, 'auth' | 'db' | 'publicOrigin'>;

/** A layout is a few KiB; anything far larger is not one. */
export const MAX_LAYOUT_BYTES = 256 * 1024;

/**
 * `GET` / `PUT /api/layout` (plan §8.2): the signed-in user's workspace layout with optimistic
 * concurrency. GET returns `{ layout, version }` (the empty layout at version 0 before the first
 * save). PUT carries the whole layout and `If-Match: <version>`; a stale version is answered with
 * 409 and the current version, and the client reloads and re-applies its change. Both pass the
 * auth gate (401 without a session, 403 while a password change or TOTP enrollment is pending);
 * PUT also requires `Origin` to be TERMDOCK_PUBLIC_URL's origin (CSRF, plan §10.2). A browser's
 * same-origin GET sends no `Origin`, so GET only refuses a foreign one.
 */
export async function getLayoutResponse(deps: LayoutDeps, request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (
    (origin !== null && origin !== deps.publicOrigin) ||
    (site !== null && site !== 'same-origin')
  ) {
    return reply(403, { code: ErrorCode.Forbidden, message: 'origin not allowed' });
  }
  const gate = await gateOrReply(deps, request);
  if (gate instanceof Response) return gate;
  const stored = getLayout(deps.db, gate.userId);
  return reply(200, stored, stored.version);
}

export async function putLayoutResponse(deps: LayoutDeps, request: Request): Promise<Response> {
  if (request.headers.get('origin') !== deps.publicOrigin) {
    return reply(403, { code: ErrorCode.Forbidden, message: 'origin not allowed' });
  }
  const gate = await gateOrReply(deps, request);
  if (gate instanceof Response) return gate;

  const expected = parseIfMatch(request.headers.get('if-match'));
  if (expected === null) {
    return reply(428, { code: ErrorCode.BadRequest, message: 'If-Match: <version> required' });
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_LAYOUT_BYTES) return tooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_LAYOUT_BYTES) return tooLarge();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return reply(400, { code: ErrorCode.BadRequest, message: 'malformed JSON' });
  }
  const parsed = WorkspaceLayout.safeParse(json);
  if (!parsed.success) {
    return reply(400, { code: ErrorCode.BadRequest, message: 'invalid layout' });
  }
  const result = saveLayout(deps.db, gate.userId, parsed.data, expected);
  if (!result.ok) {
    return reply(
      409,
      { code: ErrorCode.Conflict, message: 'layout changed', version: result.version },
      result.version,
    );
  }
  return reply(200, { version: result.version }, result.version);
}

/** `If-Match: 3`, `"3"` or `W/"3"` → 3; anything else (absent, `*`, a list) → null. */
export function parseIfMatch(value: string | null): number | null {
  if (value === null) return null;
  const match = /^\s*(?:W\/)?"?(\d{1,15})"?\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

async function gateOrReply(
  deps: LayoutDeps,
  request: Request,
): Promise<{ userId: string } | Response> {
  const gate = await authGate(deps, request.headers);
  if (gate.ok) return { userId: gate.user.id };
  if (gate.reason === 'password-change' || gate.reason === 'totp-enrollment') {
    return reply(403, { code: ErrorCode.Forbidden, message: `pending ${gate.reason}` });
  }
  return reply(401, { code: ErrorCode.Unauthenticated, message: 'authentication required' });
}

function tooLarge(): Response {
  return reply(413, { code: ErrorCode.BadRequest, message: 'layout too large' });
}

function reply(status: number, body: unknown, version?: number): Response {
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (version !== undefined) headers.etag = `"${version}"`;
  return Response.json(body, { status, headers });
}
