/**
 * Content-Security-Policy for document responses (plan §10.2). Scripts need the per-request
 * nonce (Next attaches it to its own scripts; `'strict-dynamic'` lets them load chunks).
 * Styles allow `'unsafe-inline'` because the xterm.js DOM renderer injects style elements.
 * Development adds `'unsafe-eval'`, which React needs only for dev-time stack reconstruction.
 */
export function buildCsp(nonce: string, dev = false): string {
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
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

/** A fresh base64 nonce of 128 random bits (Web Crypto: runs in any proxy runtime). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
