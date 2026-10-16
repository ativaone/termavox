import { type NextRequest, NextResponse } from 'next/server';
import { buildCsp, createNonce } from './lib/csp.ts';

/**
 * Per-request nonce CSP for every document route (plan §10.2). Next reads the nonce from the
 * request's `Content-Security-Policy` header and stamps it on its scripts, so every page is
 * rendered dynamically. API routes get a static deny-all policy from next.config.ts.
 */
export function proxy(request: NextRequest) {
  const csp = buildCsp(createNonce(), process.env.NODE_ENV === 'development');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
