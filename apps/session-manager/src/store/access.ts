import type { TermavoxDb } from '@termavox/db';
import { ErrorCode, TermavoxError } from '@termavox/shared';
import type { OwnershipCheck } from '../core/types.ts';
import type { AuthSessionValidator } from '../ws/types.ts';
import { getRow, type Sqlite } from './sqlite.ts';

/**
 * Authorization lookups over the shared DB (plan §4.4: the daemon re-validates what web
 * asserts). Foreign resources are reported as "not found" everywhere (internal API: 404), so a
 * caller cannot probe which ids exist.
 */

export interface UserAccess {
  id: string;
  role: string;
  banned: number;
  ban_expires: number | null;
}

/**
 * Better Auth admin plugin semantics: `banned` disables the account until `ban_expires`
 * (null = permanent); once that instant has passed the ban no longer applies.
 */
export function isBanned(
  user: { banned: number | boolean; ban_expires: number | null },
  now = Date.now(),
): boolean {
  if (!user.banned) return false;
  return user.ban_expires === null || user.ban_expires > now;
}

/** Better Auth stores roles as a comma-separated list. */
export function isAdmin(user: { role: string }): boolean {
  return user.role
    .split(',')
    .map((r) => r.trim())
    .includes('admin');
}

/** The acting user of an internal API call: must exist and not be banned (else FORBIDDEN). */
export function requireActingUser(sqlite: Sqlite, userId: string, now = Date.now()): UserAccess {
  const user = getRow<UserAccess>(
    sqlite,
    'SELECT id, role, banned, ban_expires FROM user WHERE id = ?',
    userId,
  );
  if (!user || isBanned(user, now)) {
    throw new TermavoxError(ErrorCode.Forbidden, 'acting user is not allowed');
  }
  return user;
}

export class SqliteOwnership implements OwnershipCheck {
  readonly #sqlite: Sqlite;

  constructor(db: TermavoxDb) {
    this.#sqlite = db.$client;
  }

  async sessionOwner(sessionId: string): Promise<string | null> {
    const row = getRow<{ user_id: string }>(
      this.#sqlite,
      'SELECT user_id FROM sessions WHERE id = ?',
      sessionId,
    );
    return row?.user_id ?? null;
  }
}

/**
 * WS auth-session revalidation (plan §7.1): the auth_session row exists, has not expired,
 * belongs to `userId`, and that user is not banned (honouring `ban_expires`).
 */
export class SqliteAuthSessionValidator implements AuthSessionValidator {
  readonly #sqlite: Sqlite;
  readonly #now: () => number;

  constructor(db: TermavoxDb, now: () => number = Date.now) {
    this.#sqlite = db.$client;
    this.#now = now;
  }

  isValid(authSessionId: string, userId: string): boolean {
    const row = getRow<{
      user_id: string;
      expires_at: number;
      banned: number;
      ban_expires: number | null;
    }>(
      this.#sqlite,
      `SELECT s.user_id, s.expires_at, u.banned, u.ban_expires
         FROM auth_session s JOIN user u ON u.id = s.user_id
        WHERE s.id = ?`,
      authSessionId,
    );
    if (!row || row.user_id !== userId) return false;
    const now = this.#now();
    if (row.expires_at <= now) return false;
    return !isBanned(row, now);
  }
}
