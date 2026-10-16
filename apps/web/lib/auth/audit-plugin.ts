import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware, getIP, isAPIError } from 'better-auth/api';
import type { WebLogger } from '../logger.ts';
import { findUserIdByUsername } from '../repo/admin-users.ts';
import { type AuditInput, insertAuditEvent } from '../repo/audit.ts';

/**
 * Audit trail of the auth endpoints (plan §10.2), as a plugin so it sees each endpoint's final
 * result: plugin after-hooks run after Termdock's own `hooks.after` and in plugin order, so placed
 * after `twoFactor` it sees a 2FA redirect (no session) instead of the provisional sign-in. Every
 * entry point (Server Actions, `/api/auth/*`, server calls) is covered the same way.
 *
 * Details hold public data only: never a password, code, token or the typed username of an
 * unknown account (it may be a mistyped password). Writes never break the auth flow.
 */

const SIGN_IN = '/sign-in/username';
const VERIFY_TOTP = '/two-factor/verify-totp';
const VERIFY_BACKUP = '/two-factor/verify-backup-code';

const AUDITED = new Set([
  SIGN_IN,
  VERIFY_TOTP,
  VERIFY_BACKUP,
  '/change-password',
  '/two-factor/disable',
  '/admin/create-user',
  '/admin/ban-user',
  '/admin/unban-user',
  '/admin/set-role',
  '/admin/set-user-password',
  '/admin/revoke-user-sessions',
]);

export interface AuditPluginOptions {
  db: TermdockDb;
  logger: WebLogger;
}

/** Request metadata recorded with each row: the trusted client IP and the user agent. */
export function requestMeta(
  headers: Headers | undefined,
  options: Parameters<typeof getIP>[1],
): { ip: string | null; userAgent: string | null } {
  if (!headers) return { ip: null, userAgent: null };
  return { ip: getIP(headers, options) || null, userAgent: headers.get('user-agent') };
}

export function auditPlugin({ db, logger }: AuditPluginOptions): BetterAuthPlugin {
  const write = (input: AuditInput) => {
    try {
      insertAuditEvent(db, input);
    } catch (err) {
      logger.error(`audit write failed (${input.type}): ${(err as Error)?.message ?? 'unknown'}`);
    }
  };

  return {
    id: 'termdock-audit',
    hooks: {
      after: [
        {
          matcher: (ctx) => AUDITED.has(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const meta = requestMeta(ctx.headers ?? ctx.request?.headers, ctx.context.options);
            const returned: unknown = ctx.context.returned;
            const failure = isAPIError(returned) ? returned : null;
            const failureCode = (failure?.body as { code?: unknown } | undefined)?.code;
            const newSession = ctx.context.newSession;
            const priorSession = ctx.context.session;
            const actorId = priorSession?.user.id ?? null;
            const body = (ctx.body ?? {}) as Record<string, unknown>;
            const targetUser = typeof body.userId === 'string' ? body.userId : null;
            const base = { ...meta };

            switch (ctx.path) {
              case SIGN_IN: {
                const username = typeof body.username === 'string' ? body.username : '';
                if (failure) {
                  const disabled = failure.statusCode === 403 && failureCode === 'BANNED_USER';
                  // 429 (locked, rate limited) and malformed requests are not attempts.
                  if (failure.statusCode !== 401 && !disabled) return;
                  const known = username ? findUserIdByUsername(db, username) : null;
                  write({
                    ...base,
                    type: 'auth.login_failure',
                    actorUserId: null,
                    targetType: known ? 'user' : null,
                    targetId: known,
                    detail: {
                      stage: 'password',
                      reason: disabled ? 'disabled' : 'invalid',
                      ...(known ? {} : { unknownUser: true }),
                    },
                  });
                  return;
                }
                // No session here means a second factor follows (verify-totp records it).
                if (!newSession) return;
                write({
                  ...base,
                  type: 'auth.login_success',
                  actorUserId: newSession.user.id,
                  targetType: 'user',
                  targetId: newSession.user.id,
                  detail: {
                    method:
                      (newSession.user as { twoFactorEnabled?: boolean | null })
                        .twoFactorEnabled === true
                        ? 'trusted_device'
                        : 'password',
                  },
                });
                return;
              }
              case VERIFY_TOTP:
              case VERIFY_BACKUP: {
                const method = ctx.path === VERIFY_TOTP ? 'totp' : 'backup_code';
                if (priorSession) {
                  // Enrollment: the first verified code turns TOTP on (and rotates the session).
                  if (!failure && newSession && ctx.path === VERIFY_TOTP) {
                    write({
                      ...base,
                      type: 'auth.totp_enable',
                      actorUserId: priorSession.user.id,
                      targetType: 'user',
                      targetId: priorSession.user.id,
                    });
                  }
                  return;
                }
                if (failure) {
                  if (failure.statusCode !== 401) return;
                  if (failureCode === 'INVALID_TWO_FACTOR_COOKIE') return;
                  write({
                    ...base,
                    type: 'auth.login_failure',
                    actorUserId: null,
                    detail: { stage: method, reason: 'invalid' },
                  });
                  return;
                }
                if (!newSession) return;
                write({
                  ...base,
                  type: 'auth.login_success',
                  actorUserId: newSession.user.id,
                  targetType: 'user',
                  targetId: newSession.user.id,
                  detail: { method },
                });
                return;
              }
              case '/change-password': {
                if (failure) return;
                const userId =
                  (returned as { user?: { id?: unknown } } | undefined)?.user?.id ?? actorId;
                if (typeof userId !== 'string') return;
                write({
                  ...base,
                  type: 'auth.password_change',
                  actorUserId: userId,
                  targetType: 'user',
                  targetId: userId,
                  detail: { otherSessionsRevoked: body.revokeOtherSessions === true },
                });
                return;
              }
              case '/two-factor/disable': {
                if (failure || !actorId) return;
                write({
                  ...base,
                  type: 'auth.totp_disable',
                  actorUserId: actorId,
                  targetType: 'user',
                  targetId: actorId,
                });
                return;
              }
              case '/admin/create-user': {
                if (failure) return;
                const user = (returned as { user?: Record<string, unknown> } | undefined)?.user;
                if (!user || typeof user.id !== 'string') return;
                const data = (body.data ?? {}) as Record<string, unknown>;
                write({
                  ...base,
                  type: 'user.create',
                  // Null during first-run setup (a trusted server call without a session).
                  actorUserId: actorId,
                  targetType: 'user',
                  targetId: user.id,
                  detail: {
                    username: typeof user.username === 'string' ? user.username : null,
                    role: typeof body.role === 'string' ? body.role : 'user',
                    totpRequired: data.totpRequired === true,
                    temporaryPassword: data.mustChangePassword === true,
                  },
                });
                return;
              }
              case '/admin/ban-user':
              case '/admin/unban-user':
              case '/admin/set-role':
              case '/admin/set-user-password':
              case '/admin/revoke-user-sessions': {
                if (failure || !targetUser) return;
                const type = (
                  {
                    '/admin/ban-user': 'user.ban',
                    '/admin/unban-user': 'user.unban',
                    '/admin/set-role': 'user.role_change',
                    '/admin/set-user-password': 'auth.password_reset',
                    '/admin/revoke-user-sessions': 'auth_session.revoke',
                  } as const
                )[ctx.path];
                write({
                  ...base,
                  type,
                  actorUserId: actorId,
                  targetType: 'user',
                  targetId: targetUser,
                  ...(ctx.path === '/admin/set-role' && typeof body.role === 'string'
                    ? { detail: { role: body.role } }
                    : {}),
                  ...(ctx.path === '/admin/revoke-user-sessions'
                    ? { detail: { scope: 'auth_sessions' } }
                    : {}),
                });
                return;
              }
            }
          }),
        },
      ],
    },
  };
}
