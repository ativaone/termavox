import '../server-guard.ts';
import { ErrorCode, TermdockError } from '@termdock/shared';
import {
  createUserWithTemporaryPassword,
  type NewUserInput,
  resetUserTotp,
  setTemporaryPassword,
} from '../auth/account.ts';
import { requestMeta } from '../auth/audit-plugin.ts';
import type { AuthSession } from '../auth/auth.ts';
import { authGate, type GateDeps } from '../auth/gate.ts';
import type { InternalApiClient } from '../internal-api.ts';
import { insertAuditEvent } from '../repo/audit.ts';
import {
  getInstanceSettings,
  type InstanceSettings,
  SETTING_KEYS,
  setInstanceSetting,
} from '../repo/instance-settings.ts';

/**
 * Admin operations (plan §8.1 /admin/*), separated from their Server Actions so they can be
 * tested with an injected internal API. Every one starts with {@link requireAdminOrNotFound}:
 * a signed-in user who is not an admin gets NOT_FOUND, exactly like a missing page, so the
 * admin surface is never revealed. Better Auth's admin plugin performs the account changes (and
 * the audit plugin records them); the rest is audited here.
 */

export interface AdminDeps extends GateDeps {
  internalApi: Pick<InternalApiClient, 'revokeAuthSessions' | 'terminateUserSessions'>;
}

export function isAdminRole(role: string | null | undefined): boolean {
  return (role ?? '')
    .split(',')
    .map((r) => r.trim())
    .includes('admin');
}

/** UNAUTHENTICATED without a usable session; NOT_FOUND for anyone but an admin. */
export async function requireAdminOrNotFound(
  deps: GateDeps,
  headers: Headers,
): Promise<AuthSession> {
  const gate = await authGate(deps, headers);
  if (!gate.ok) throw new TermdockError(ErrorCode.Unauthenticated, `not allowed: ${gate.reason}`);
  if (!isAdminRole(gate.user.role)) throw new TermdockError(ErrorCode.NotFound, 'not found');
  return { session: gate.session, user: gate.user };
}

function meta(deps: GateDeps, headers: Headers) {
  return requestMeta(headers, deps.auth.options);
}

export async function adminCreateUser(
  deps: AdminDeps,
  headers: Headers,
  input: NewUserInput,
): Promise<{ userId: string }> {
  await requireAdminOrNotFound(deps, headers);
  return createUserWithTemporaryPassword(deps, headers, input);
}

export interface BanOutcome {
  /** The user's WebSockets were closed at once (false: the session service was unreachable). */
  connectionsClosed: boolean;
  /** Sessions terminated, when requested; null if not requested or if the call failed. */
  terminated: number | null;
  terminateFailed: boolean;
}

/**
 * Disables or re-enables an account (Better Auth `banned`). Disabling deletes the user's auth
 * sessions (Better Auth) and closes their WebSockets through the daemon; terminal sessions keep
 * running unless `terminateSessions` is set. Admins cannot disable themselves.
 */
export async function adminSetBanned(
  deps: AdminDeps,
  headers: Headers,
  input: { userId: string; banned: boolean; terminateSessions?: boolean },
): Promise<BanOutcome> {
  const admin = await requireAdminOrNotFound(deps, headers);
  if (input.userId === admin.user.id) {
    throw new TermdockError(ErrorCode.BadRequest, 'admins cannot disable their own account');
  }
  const outcome: BanOutcome = {
    connectionsClosed: false,
    terminated: null,
    terminateFailed: false,
  };
  if (!input.banned) {
    await callAuth(() => deps.auth.api.unbanUser({ headers, body: { userId: input.userId } }));
    return outcome;
  }
  await callAuth(() => deps.auth.api.banUser({ headers, body: { userId: input.userId } }));
  const audit = { actorUserId: admin.user.id, targetType: 'user' as const, ...meta(deps, headers) };
  try {
    await deps.internalApi.revokeAuthSessions({ userId: input.userId });
    outcome.connectionsClosed = true;
    insertAuditEvent(deps.db, {
      ...audit,
      type: 'auth_session.revoke',
      targetId: input.userId,
      detail: { scope: 'websockets', reason: 'ban' },
    });
  } catch {
    outcome.connectionsClosed = false;
  }
  if (input.terminateSessions) {
    try {
      const { terminated } = await deps.internalApi.terminateUserSessions(
        input.userId,
        admin.user.id,
      );
      outcome.terminated = terminated;
      insertAuditEvent(deps.db, {
        ...audit,
        type: 'user.sessions_terminate',
        targetId: input.userId,
        detail: { terminated, reason: 'ban' },
      });
    } catch {
      outcome.terminateFailed = true;
    }
  }
  return outcome;
}

/** Admin TOTP reset: the user enrolls again at next sign-in when TOTP is required for them. */
export async function adminResetTotp(
  deps: AdminDeps,
  headers: Headers,
  userId: string,
): Promise<void> {
  const admin = await requireAdminOrNotFound(deps, headers);
  await resetUserTotp(deps, headers, userId);
  insertAuditEvent(deps.db, {
    type: 'auth.totp_reset',
    actorUserId: admin.user.id,
    targetType: 'user',
    targetId: userId,
    ...meta(deps, headers),
  });
}

/**
 * Temporary password with a forced change at next sign-in; the user's auth sessions are revoked
 * (Better Auth) and their WebSockets closed. Returns whether the WebSockets were closed.
 */
export async function adminResetPassword(
  deps: AdminDeps,
  headers: Headers,
  input: { userId: string; temporaryPassword: string },
): Promise<{ connectionsClosed: boolean }> {
  await requireAdminOrNotFound(deps, headers);
  await setTemporaryPassword(deps, headers, input.userId, input.temporaryPassword);
  try {
    await deps.internalApi.revokeAuthSessions({ userId: input.userId });
    return { connectionsClosed: true };
  } catch {
    return { connectionsClosed: false };
  }
}

export async function adminSetRole(
  deps: AdminDeps,
  headers: Headers,
  input: { userId: string; role: 'admin' | 'user' },
): Promise<void> {
  const admin = await requireAdminOrNotFound(deps, headers);
  if (input.userId === admin.user.id && input.role !== 'admin') {
    throw new TermdockError(ErrorCode.BadRequest, 'admins cannot remove their own admin role');
  }
  await callAuth(() =>
    deps.auth.api.setRole({ headers, body: { userId: input.userId, role: input.role } }),
  );
}

/** Saves instance settings; each changed key is audited with its old and new value. */
export async function adminSaveSettings(
  deps: AdminDeps,
  headers: Headers,
  next: InstanceSettings,
): Promise<{ changed: string[] }> {
  const admin = await requireAdminOrNotFound(deps, headers);
  const current = getInstanceSettings(deps.db);
  const changed: string[] = [];
  const now = Date.now();
  const requestInfo = meta(deps, headers);
  for (const name of Object.keys(SETTING_KEYS) as Array<keyof InstanceSettings>) {
    if (current[name] === next[name]) continue;
    const key = SETTING_KEYS[name];
    setInstanceSetting(deps.db, key, next[name], now);
    insertAuditEvent(deps.db, {
      type: 'admin_setting.change',
      actorUserId: admin.user.id,
      targetType: 'setting',
      targetId: key,
      detail: { key, from: current[name], to: next[name] },
      at: now,
      ...requestInfo,
    });
    changed.push(key);
  }
  return { changed };
}

/** Runs a Better Auth API call, translating its APIError into a TermdockError. */
async function callAuth<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const status = (err as { statusCode?: unknown })?.statusCode;
    if (typeof status !== 'number') throw err;
    const code =
      status === 404
        ? ErrorCode.NotFound
        : status === 403
          ? ErrorCode.Forbidden
          : status === 400
            ? ErrorCode.BadRequest
            : ErrorCode.Internal;
    const betterAuthCode = (err as { body?: { code?: unknown } }).body?.code;
    throw new TermdockError(code, (err as Error).message, { betterAuthCode });
  }
}
