/**
 * Where the auth gate sends a browser. A pure table with no server imports, so `lib/routes.ts`
 * (and through it every client component that links to a page) stays safe in browser bundles:
 * the gate itself (`gate.ts`) imports the server guard and must never be bundled for the browser.
 * Renaming a page only touches this table.
 */
export const AUTH_ROUTES = {
  login: '/login',
  setup: '/setup',
  changePassword: '/login/change-password',
  enrollTotp: '/login/enroll-totp',
} as const;
