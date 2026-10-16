import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';
import type { AuthSession, TermdockAuth } from './auth.ts';
import { hasAnyUser, isTotpRequiredInstanceWide } from './queries.ts';
import { type AuthRequirement, isBanned, pendingRequirement } from './requirements.ts';

/**
 * Where the gate sends a browser. The pages arrive with the UI phase; renaming one only touches
 * this table.
 */
export const AUTH_ROUTES = {
  login: '/login',
  setup: '/setup',
  changePassword: '/login/change-password',
  enrollTotp: '/login/enroll-totp',
} as const;

const REQUIREMENT_ROUTE: Record<AuthRequirement, string> = {
  'password-change': AUTH_ROUTES.changePassword,
  'totp-enrollment': AUTH_ROUTES.enrollTotp,
};

export type GateResult =
  | ({ ok: true } & AuthSession)
  | { ok: false; reason: 'setup-required' | 'unauthenticated' | 'banned'; redirectTo: string }
  | ({ ok: false; reason: AuthRequirement; redirectTo: string } & AuthSession);

export interface GateOptions {
  /**
   * Requirements this caller serves itself: the change-password page passes `password-change`,
   * the enrollment page `totp-enrollment`. Every other caller passes nothing.
   */
  allow?: readonly AuthRequirement[];
}

export interface GateDeps {
  auth: TermdockAuth;
  db: TermdockDb;
}

/**
 * The single server-side auth check for every page, Server Action and route handler (plan §8.1,
 * §10.2). It resolves the Better Auth session from the request headers, rejects disabled
 * (`banned`) accounts, and holds the user on a pending password change, then on a pending TOTP
 * enrollment (per-user `totpRequired` or the instance-wide `require_totp`), before anything else.
 */
export async function authGate(
  deps: GateDeps,
  headers: Headers,
  options: GateOptions = {},
): Promise<GateResult> {
  const found = await deps.auth.api.getSession({ headers });
  if (!found) {
    return hasAnyUser(deps.db)
      ? { ok: false, reason: 'unauthenticated', redirectTo: AUTH_ROUTES.login }
      : { ok: false, reason: 'setup-required', redirectTo: AUTH_ROUTES.setup };
  }
  // Better Auth deletes a banned user's sessions, but getSession does not re-check `banned`.
  if (isBanned(found.user)) return { ok: false, reason: 'banned', redirectTo: AUTH_ROUTES.login };
  const pending = pendingRequirement(found.user, isTotpRequiredInstanceWide(deps.db));
  if (pending && !options.allow?.includes(pending)) {
    return { ok: false, reason: pending, redirectTo: REQUIREMENT_ROUTE[pending], ...found };
  }
  return { ok: true, ...found };
}
