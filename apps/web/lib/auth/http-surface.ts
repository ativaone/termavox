import '../server-guard.ts';

/**
 * The Better Auth endpoints served over HTTP (`/api/auth/*`), as `METHOD pathname`. Sign-in,
 * two-factor, account and admin operations all run in Server Actions through `auth.api` in
 * process, so the browser needs only the workspace's sliding-expiry keep-alive
 * (components/workspace/hooks.ts). Everything else Better Auth would expose (its admin plugin
 * endpoints, `/update-user`, `/is-username-available`, sign-in itself) answers 404 without
 * reaching `auth.handler`, which would skip the Server Actions' guards and audit rows.
 */
export const AUTH_HTTP_ALLOWLIST: ReadonlySet<string> = new Set(['GET /api/auth/get-session']);

/**
 * Exact match on the method and the URL's pathname as parsed, with no decoding or normalization
 * that could widen it (a trailing slash, `//` or a percent-encoded letter does not match). Query
 * strings are ignored.
 */
export function isServedAuthRequest(request: Request): boolean {
  return AUTH_HTTP_ALLOWLIST.has(`${request.method} ${new URL(request.url).pathname}`);
}

/** Hands an allowlisted request to `handler` (Better Auth's); anything else answers 404. */
export async function serveAuthRequest(
  request: Request,
  handler: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (!isServedAuthRequest(request)) return new Response('Not Found', { status: 404 });
  return handler(request);
}
