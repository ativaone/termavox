import '../server-guard.ts';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { isAPIError } from 'better-auth/api';
import { z } from 'zod';
import type { AuthSession } from './auth.ts';
import { authGate, type GateDeps } from './gate.ts';
import { resetTotp } from './queries.ts';

/**
 * Account and admin operations Better Auth does not cover on its own (ADR-0004). Each one goes
 * through the auth gate first; Server Actions call these and map TermdockError to their result.
 */

/** Gate + role check for admin operations. */
export async function requireAdmin(deps: GateDeps, headers: Headers): Promise<AuthSession> {
  const gate = await authGate(deps, headers);
  if (!gate.ok) {
    const code = 'user' in gate ? ErrorCode.Forbidden : ErrorCode.Unauthenticated;
    throw new TermdockError(code, `not allowed: ${gate.reason}`);
  }
  if (gate.user.role !== 'admin') throw new TermdockError(ErrorCode.Forbidden, 'admin only');
  return { session: gate.session, user: gate.user };
}

/**
 * The user's own password change, also the way out of a forced change (`mustChangePassword`;
 * Termdock's after-hook on `/change-password` clears the flag). Other sessions are revoked.
 */
export async function changePassword(
  deps: GateDeps,
  headers: Headers,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const gate = await authGate(deps, headers, { allow: ['password-change', 'totp-enrollment'] });
  if (!gate.ok && !('user' in gate)) {
    throw new TermdockError(ErrorCode.Unauthenticated, `not allowed: ${gate.reason}`);
  }
  await call(() =>
    deps.auth.api.changePassword({ headers, body: { ...input, revokeOtherSessions: true } }),
  );
}

export const NewUserInput = z.object({
  username: z.string().trim().min(3).max(30),
  email: z.email(),
  name: z.string().trim().min(1).max(100).optional(),
  temporaryPassword: z.string().min(12).max(128),
  role: z.enum(['admin', 'user']).default('user'),
  totpRequired: z.boolean().default(false),
});
export type NewUserInput = z.input<typeof NewUserInput>;

/** Admin creates a user with a temporary password; the first login forces a change. */
export async function createUserWithTemporaryPassword(
  deps: GateDeps,
  headers: Headers,
  input: NewUserInput,
): Promise<{ userId: string }> {
  await requireAdmin(deps, headers);
  const v = parse(NewUserInput, input);
  const { user } = await call(() =>
    deps.auth.api.createUser({
      headers,
      body: {
        email: v.email,
        password: v.temporaryPassword,
        name: v.name ?? v.username,
        role: v.role,
        data: { username: v.username, mustChangePassword: true, totpRequired: v.totpRequired },
      },
    }),
  );
  return { userId: user.id };
}

/** Admin resets a password to a temporary one: forced change at next login, sessions revoked. */
export async function setTemporaryPassword(
  deps: GateDeps,
  headers: Headers,
  userId: string,
  temporaryPassword: string,
): Promise<void> {
  await requireAdmin(deps, headers);
  const newPassword = parse(z.string().min(12).max(128), temporaryPassword);
  await call(() => deps.auth.api.setUserPassword({ headers, body: { userId, newPassword } }));
  const ctx = await deps.auth.$context;
  await ctx.internalAdapter.updateUser(userId, { mustChangePassword: true });
  await call(() => deps.auth.api.revokeUserSessions({ headers, body: { userId } }));
}

/**
 * Admin TOTP reset (not in Better Auth's admin plugin): deletes the secret and backup codes,
 * clears `twoFactorEnabled` and forgets trusted devices. If TOTP is required for the user, the
 * gate forces a new enrollment.
 */
export async function resetUserTotp(
  deps: GateDeps,
  headers: Headers,
  userId: string,
): Promise<void> {
  await requireAdmin(deps, headers);
  if (!resetTotp(deps.db, userId)) throw new TermdockError(ErrorCode.NotFound, 'user not found');
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TermdockError(
      ErrorCode.BadRequest,
      parsed.error.issues[0]?.message ?? 'invalid input',
    );
  }
  return parsed.data;
}

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: ErrorCode.BadRequest,
  401: ErrorCode.Unauthenticated,
  403: ErrorCode.Forbidden,
  404: ErrorCode.NotFound,
  429: ErrorCode.RateLimited,
};

/** Runs a Better Auth API call, translating its APIError into a TermdockError. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isAPIError(err)) throw err;
    const code = CODE_BY_STATUS[err.statusCode] ?? ErrorCode.Internal;
    throw new TermdockError(code, err.message, { betterAuthCode: err.body?.code });
  }
}
