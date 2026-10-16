/**
 * Content-Security-Policy for document responses (plan §10.2). Scripts need the per-request
 * nonce (Next attaches it to its own scripts; `'strict-dynamic'` lets them load chunks).
 * Styles allow `'unsafe-inline'` because the xterm.js DOM renderer injects style elements.
 * Development adds `'unsafe-eval'`, which React needs only for dev-time stack reconstruction.
 * The terminal WebSocket is same-origin `/ws` (`'self'`); when NEXT_PUBLIC_TERMDOCK_WS_URL points
 * elsewhere (development), pass it as `wsUrl` and its origin joins `connect-src`.
 */
export function buildCsp(nonce: string, dev = false, wsUrl?: string): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'blob:', 'data:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...wsSource(wsUrl)],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

/** The origin of a ws:/wss: URL as a CSP source, or nothing for an absent or unusable URL. */
export function wsSource(wsUrl: string | undefined): string[] {
  if (!wsUrl) return [];
  try {
    const url = new URL(wsUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return [];
    return [`${url.protocol}//${url.host}`];
  } catch {
    return [];
  }
}

/** A fresh base64 nonce of 128 random bits (Web Crypto: runs in any proxy runtime). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
