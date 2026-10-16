import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';
import { ErrorCode, TermdockError } from '@termdock/shared';

/**
 * The user directory for `/admin/users` (admins only: FORBIDDEN otherwise). Mutations go through
 * Better Auth's admin plugin (lib/admin), never through here.
 */

export interface AdminUserRow {
  id: string;
  username: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  twoFactorEnabled: boolean;
  totpRequired: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  /** Latest successful sign-in (audit log, else the newest auth session); null if unknown. */
  lastSignInAt: number | null;
}

function assertAdmin(viewer: { role?: string | null }): void {
  const roles = (viewer.role ?? '').split(',').map((r) => r.trim());
  if (!roles.includes('admin')) throw new TermdockError(ErrorCode.Forbidden, 'admin only');
}

const SELECT_USER = `
  SELECT u.id, COALESCE(u.display_username, u.username, u.name) AS username, u.name, u.email,
         u.role, u.banned, u.ban_expires, u.two_factor_enabled, u.totp_required,
         u.must_change_password, u.created_at,
         COALESCE(
           (SELECT MAX(a.created_at) FROM audit_events a
             WHERE a.type = 'auth.login_success' AND a.actor_user_id = u.id),
           (SELECT MAX(s.created_at) FROM auth_session s WHERE s.user_id = u.id)
         ) AS last_sign_in
    FROM user u`;

interface UserRow {
  id: string;
  username: string;
  name: string;
  email: string;
  role: string;
  banned: number;
  ban_expires: number | null;
  two_factor_enabled: number;
  totp_required: number;
  must_change_password: number;
  created_at: number;
  last_sign_in: number | null;
}

function toRow(r: UserRow, now: number): AdminUserRow {
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    email: r.email,
    role: r.role,
    banned: r.banned !== 0 && (r.ban_expires === null || r.ban_expires > now),
    twoFactorEnabled: r.two_factor_enabled !== 0,
    totpRequired: r.totp_required !== 0,
    mustChangePassword: r.must_change_password !== 0,
    createdAt: r.created_at,
    lastSignInAt: r.last_sign_in,
  };
}

export function listUsersForAdmin(
  db: TermdockDb,
  viewer: { role?: string | null },
  now: number = Date.now(),
): AdminUserRow[] {
  assertAdmin(viewer);
  const rows = db.$client
    .prepare(`${SELECT_USER} ORDER BY username COLLATE NOCASE, u.id`)
    .all() as UserRow[];
  return rows.map((r) => toRow(r, now));
}

export function getUserForAdmin(
  db: TermdockDb,
  viewer: { role?: string | null },
  userId: string,
  now: number = Date.now(),
): AdminUserRow | null {
  assertAdmin(viewer);
  const row = db.$client.prepare(`${SELECT_USER} WHERE u.id = ?`).get(userId) as
    | UserRow
    | undefined;
  return row ? toRow(row, now) : null;
}

/** Live (not ended) sessions of a user: shown before an admin terminates them. */
export function countLiveSessionsForAdmin(
  db: TermdockDb,
  viewer: { role?: string | null },
  userId: string,
): number {
  assertAdmin(viewer);
  const row = db.$client
    .prepare("SELECT COUNT(*) AS total FROM sessions WHERE user_id = ? AND state <> 'ended'")
    .get(userId) as { total: number };
  return row.total;
}

/** Username → id, for audit targets (sign-in failures name only existing accounts). */
export function findUserIdByUsername(db: TermdockDb, username: string): string | null {
  const row = db.$client
    .prepare('SELECT id FROM user WHERE username = ?')
    .get(username.trim().toLowerCase()) as { id: string } | undefined;
  return row?.id ?? null;
}
