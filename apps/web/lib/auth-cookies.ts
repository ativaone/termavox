/**
 * Better Auth cookie names as configured in lib/auth/auth.ts (`cookiePrefix: 'termdock'`,
 * `useSecureCookies: true`, hence the `__Secure-` prefix). Pages only test for their presence;
 * Better Auth itself verifies their signatures.
 */
export const SESSION_COOKIE = '__Secure-termdock.session_token';
export const TWO_FACTOR_COOKIE = '__Secure-termdock.two_factor';
