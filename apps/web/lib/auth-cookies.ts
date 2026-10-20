/**
 * Better Auth cookie names as configured in lib/auth/auth.ts (`cookiePrefix: 'termavox'`,
 * `useSecureCookies: true`, hence the `__Secure-` prefix). Pages only test for their presence;
 * Better Auth itself verifies their signatures.
 */
export const SESSION_COOKIE = '__Secure-termavox.session_token';
export const TWO_FACTOR_COOKIE = '__Secure-termavox.two_factor';
