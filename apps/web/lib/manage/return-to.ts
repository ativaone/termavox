/**
 * "Back to where you were" (plan D-27). A page reached from another one carries `?from=<path>`
 * and offers a way back there once its job is done. Only these in-app pages are honored, matched
 * whole (no query, no fragment, no other origin): the workspace, the servers list, Add server, a
 * server's page and the credentials. Anything else is dropped, so the parameter can never send
 * anyone off-site.
 */
const RETURN_PATHS: readonly RegExp[] = [
  /^\/workspace$/,
  /^\/servers$/,
  /^\/servers\/new$/,
  /^\/servers\/[0-9A-Za-z-]{1,64}$/,
  /^\/credentials$/,
];

/** The `from` value when it names an allowed page, else null. */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return RETURN_PATHS.some((pattern) => pattern.test(raw)) ? raw : null;
}

/** `href` with `from` attached (dropped when `from` is not an allowed page). */
export function withReturnPath(href: string, from: string | null | undefined): string {
  const safe = safeReturnPath(from);
  if (!safe) return href;
  return `${href}${href.includes('?') ? '&' : '?'}from=${encodeURIComponent(safe)}`;
}
