import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';
import { schema } from '@termdock/db';
import {
  type Argon2Params,
  DEFAULT_ARGON2_PARAMS,
  hashPassword,
  uuidv7,
  verifyPassword,
} from '@termdock/shared';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getIP, isAPIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { admin } from 'better-auth/plugins/admin';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { username } from 'better-auth/plugins/username';
import type { WebLogger } from '../logger.ts';
import { findUserIdByUsername } from '../repo/admin-users.ts';
import { insertAuditEvent } from '../repo/audit.ts';
import { auditPlugin } from './audit-plugin.ts';
import type { LoginLockout } from './lockout.ts';
import { isTotpRequiredInstanceWide } from './queries.ts';
import {
  type BanUser,
  isBanned,
  pendingRequirement,
  type RequirementUser,
  totpRequiredFor,
} from './requirements.ts';

const DAY_S = 24 * 60 * 60;
export const SIGN_IN_PATH = '/sign-in/username';

/**
 * Better Auth paths still served while a password change or TOTP enrollment is pending (ADR-0004).
 * Every other path answers 403 for such a session. `/two-factor/verify-totp` also serves the normal
 * second step of a TOTP sign-in, which has no session yet.
 */
export const PENDING_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  '/get-session',
  '/sign-out',
  '/change-password',
  '/two-factor/enable',
  '/two-factor/verify-totp',
  '/two-factor/get-totp-uri',
  SIGN_IN_PATH,
]);

/**
 * Routes Termdock never serves: sign-in is by username only (an email sign-in would bypass the
 * per-username lockout), there is no public sign-up, and admins cannot impersonate users (D-08:
 * users are isolated; impersonation would let an admin drive another user's terminals).
 */
export const DISABLED_PATHS = [
  '/sign-in/email',
  '/sign-up/email',
  '/admin/impersonate-user',
  '/admin/stop-impersonating',
];

export interface CreateAuthOptions {
  db: TermdockDb;
  /** TERMDOCK_PUBLIC_URL: Better Auth's base URL; its origin is the only trusted origin. */
  publicUrl: string;
  /** Trimmed content of BETTER_AUTH_SECRET_FILE. */
  secret: string;
  lockout: LoginLockout;
  logger: WebLogger;
  argon2?: Argon2Params;
  /** Better Auth's per-IP rate limiter (on in production; tests turn it off). */
  rateLimit?: boolean;
}

interface HookSession {
  user: RequirementUser & BanUser & { id: string };
}

/** The Better Auth instance for Termdock (plugins, model mapping, cookies, hooks: ADR-0004). */
export function createAuth(options: CreateAuthOptions) {
  const { db, lockout, logger } = options;
  const argon2Params = options.argon2 ?? DEFAULT_ARGON2_PARAMS;
  // Bound after the instance exists; the hooks only run on requests, never during construction.
  let lookupSession: ((headers: Headers) => Promise<HookSession | null>) | undefined;

  const auth = betterAuth({
    appName: 'Termdock',
    baseURL: options.publicUrl,
    secret: options.secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: {
      // Required by the username plugin; sign-in by email and sign-up are disabled.
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: {
        hash: (password) => hashPassword(password, argon2Params),
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
    },
    session: {
      modelName: 'authSession',
      expiresIn: 7 * DAY_S,
      updateAge: DAY_S,
    },
    user: {
      additionalFields: {
        locale: { type: 'string', required: false, defaultValue: 'en', input: false },
        totpRequired: { type: 'boolean', required: false, defaultValue: false, input: false },
        mustChangePassword: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
    },
    plugins: [
      // Users cannot rename themselves (audit trails stay readable); admins still can.
      username({ immutableUsername: true }),
      twoFactor({ issuer: 'Termdock', trustDeviceMaxAge: 30 * DAY_S }),
      admin({ defaultRole: 'user', adminRoles: ['admin'] }),
      // After twoFactor: it audits each auth endpoint's final result (lib/auth/audit-plugin.ts).
      auditPlugin({ db, logger }),
      // Must stay last: copies Set-Cookie into Next's cookie store for Server Actions.
      nextCookies(),
    ],
    disabledPaths: DISABLED_PATHS,
    rateLimit: { enabled: options.rateLimit ?? true, storage: 'memory' },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: 'termdock',
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'strict' },
      // Caddy is the only proxy and overwrites X-Forwarded-For with the peer address, so the
      // header has exactly one value. Web must not be reachable except through Caddy (§4.3).
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
      database: { generateId: () => uuidv7() },
    },
    telemetry: { enabled: false },
    logger: {
      level: 'warn',
      log: (level, message) => {
        if (level === 'error') logger.error(`[better-auth] ${message}`);
        else logger.warn(`[better-auth] ${message}`);
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const headers = ctx.headers ?? ctx.request?.headers;
        if (ctx.path === SIGN_IN_PATH) {
          const name = signInUsername(ctx.body);
          if (!name) return;
          const retryMs = lockout.retryAfterMs(name, clientIp(headers, ctx.context.options));
          if (retryMs > 0) {
            const retryAfter = Math.ceil(retryMs / 1000);
            throw new APIError(
              'TOO_MANY_REQUESTS',
              {
                code: 'SIGN_IN_LOCKED',
                message: 'Too many failed sign-in attempts. Try again later.',
                retryAfter,
              },
              { 'Retry-After': String(retryAfter) },
            );
          }
          return;
        }
        if (ctx.path === '/change-password') {
          const body = ctx.body as { currentPassword?: unknown; newPassword?: unknown } | undefined;
          if (typeof body?.newPassword === 'string' && body.newPassword === body.currentPassword) {
            throw new APIError('BAD_REQUEST', {
              code: 'PASSWORD_UNCHANGED',
              message: 'The new password must differ from the current one.',
            });
          }
        }
        if (PENDING_ALLOWED_PATHS.has(ctx.path) || !headers || !lookupSession) return;
        const session = await lookupSession(headers);
        if (!session) return;
        if (isBanned(session.user)) {
          throw new APIError('FORBIDDEN', { code: 'BANNED_USER', message: 'Account disabled.' });
        }
        const instanceRequiresTotp = isTotpRequiredInstanceWide(db);
        const pending = pendingRequirement(session.user, instanceRequiresTotp);
        if (pending) {
          throw new APIError('FORBIDDEN', {
            code: 'AUTH_REQUIREMENT_PENDING',
            message: `Complete the pending ${pending} first.`,
            requirement: pending,
          });
        }
        if (
          ctx.path === '/two-factor/disable' &&
          totpRequiredFor(session.user, instanceRequiresTotp)
        ) {
          throw new APIError('FORBIDDEN', {
            code: 'TOTP_REQUIRED',
            message: 'Two-factor authentication is required for this account.',
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned: unknown = ctx.context.returned;
        if (ctx.path === SIGN_IN_PATH) {
          const name = signInUsername(ctx.body);
          if (!name) return;
          const ip = clientIp(ctx.headers ?? ctx.request?.headers, ctx.context.options);
          if (isAPIError(returned)) {
            // 401 = unknown username or wrong password (banned users get 403 and do not count).
            if (returned.statusCode !== 401) return;
            const { lockedForMs } = lockout.recordFailure(name, ip);
            if (lockedForMs > 0) {
              logger.warn(
                `sign-in locked for ${Math.ceil(lockedForMs / 1000)} s after repeated failures (username ${JSON.stringify(name)}, ip ${ip})`,
              );
              const target = findUserIdByUsername(db, name);
              try {
                insertAuditEvent(db, {
                  type: 'auth.lockout',
                  actorUserId: null,
                  targetType: target ? 'user' : null,
                  targetId: target,
                  detail: {
                    lockedForS: Math.ceil(lockedForMs / 1000),
                    ...(target ? {} : { unknownUser: true }),
                  },
                  ip: ip === 'unknown' ? null : ip,
                  userAgent: (ctx.headers ?? ctx.request?.headers)?.get('user-agent') ?? null,
                });
              } catch {
                logger.error('audit write failed (auth.lockout)');
              }
            }
          } else if (returned !== undefined) {
            // The password was right (a TOTP challenge may still follow; it has its own lockout).
            lockout.recordSuccess(name, ip);
          }
          return;
        }
        if (ctx.path === '/change-password' && !isAPIError(returned)) {
          const userId = (returned as { user?: { id?: unknown } } | undefined)?.user?.id;
          if (typeof userId === 'string') {
            await ctx.context.internalAdapter.updateUser(userId, { mustChangePassword: false });
          }
        }
      }),
    },
  });

  lookupSession = (headers) =>
    auth.api.getSession({
      headers,
      query: { disableRefresh: true },
    }) as Promise<HookSession | null>;
  return auth;
}

export type TermdockAuth = ReturnType<typeof createAuth>;
export type AuthSession = TermdockAuth['$Infer']['Session'];

function signInUsername(body: unknown): string | null {
  const value = (body as { username?: unknown } | undefined)?.username;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function clientIp(headers: Headers | undefined, options: Parameters<typeof getIP>[1]): string {
  return (headers && getIP(headers, options)) || 'unknown';
}
