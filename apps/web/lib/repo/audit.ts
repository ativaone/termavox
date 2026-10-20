import '../server-guard.ts';
import type { TermavoxDb } from '@termavox/db';
import { ErrorCode, TermavoxError, uuidv7 } from '@termavox/shared';

/**
 * `audit_events` rows written by web (plan §9 write ownership, §10.2): sign-in, lockout, TOTP,
 * passwords, user administration, instance settings, auth-session revocation and server
 * create/update/delete (plan D-29). The daemon writes the credential and host-key rows with the
 * same dotted vocabulary. Details carry public data only (ids, usernames, roles, setting values,
 * server names and addresses); never a password, code or key.
 */
export type WebAuditType =
  | 'auth.login_success'
  | 'auth.login_failure'
  | 'auth.lockout'
  | 'auth.password_change'
  | 'auth.password_reset'
  | 'auth.totp_enable'
  | 'auth.totp_disable'
  | 'auth.totp_reset'
  | 'auth_session.revoke'
  | 'user.create'
  | 'user.ban'
  | 'user.unban'
  | 'user.role_change'
  | 'user.sessions_terminate'
  | 'admin_setting.change'
  | 'server.create'
  | 'server.update'
  | 'server.delete';

export interface AuditInput {
  type: WebAuditType;
  actorUserId: string | null;
  targetType?: 'user' | 'setting' | 'server' | null;
  targetId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  at?: number;
}

const MAX_USER_AGENT = 256;

export function insertAuditEvent(db: TermavoxDb, input: AuditInput): void {
  const at = input.at ?? Date.now();
  db.$client
    .prepare(
      `INSERT INTO audit_events
         (id, actor_user_id, type, target_type, target_id, detail_json, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uuidv7(at),
      input.actorUserId,
      input.type,
      input.targetType ?? null,
      input.targetId ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
      input.ip ?? null,
      input.userAgent ? input.userAgent.slice(0, MAX_USER_AGENT) : null,
      at,
    );
}

/** Who is reading: the audit log is readable by admins only. */
export interface AuditViewer {
  id: string;
  role?: string | null;
}

function assertAdmin(viewer: AuditViewer): void {
  const roles = (viewer.role ?? '').split(',').map((r) => r.trim());
  if (!roles.includes('admin')) throw new TermavoxError(ErrorCode.Forbidden, 'admin only');
}

export interface AuditFilter {
  type?: string;
  actorId?: string;
  /** Inclusive epoch ms bounds. */
  from?: number;
  to?: number;
}

export interface AuditRow {
  id: string;
  type: string;
  actorId: string | null;
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
}

function whereOf(filter: AuditFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.type) {
    clauses.push('a.type = ?');
    params.push(filter.type);
  }
  if (filter.actorId) {
    clauses.push('a.actor_user_id = ?');
    params.push(filter.actorId);
  }
  if (filter.from !== undefined) {
    clauses.push('a.created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('a.created_at <= ?');
    params.push(filter.to);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function parseDetail(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Newest first, filtered and paginated. Admins only (FORBIDDEN otherwise). */
export function listAuditEvents(
  db: TermavoxDb,
  viewer: AuditViewer,
  filter: AuditFilter,
  page: { limit: number; offset: number },
): { rows: AuditRow[]; total: number } {
  assertAdmin(viewer);
  const where = whereOf(filter);
  const sqlite = db.$client;
  const { total } = sqlite
    .prepare(`SELECT COUNT(*) AS total FROM audit_events a ${where.sql}`)
    .get(...where.params) as { total: number };
  const rows = sqlite
    .prepare(
      `SELECT a.id, a.type, a.actor_user_id, actor.username AS actor_name, a.target_type,
              a.target_id, COALESCE(tu.username, tsv.name, tc.name, tsn.label) AS target_name,
              a.detail_json, a.ip, a.user_agent, a.created_at
         FROM audit_events a
         LEFT JOIN user actor ON actor.id = a.actor_user_id
         LEFT JOIN user tu ON a.target_type = 'user' AND tu.id = a.target_id
         LEFT JOIN servers tsv ON a.target_type = 'server' AND tsv.id = a.target_id
         LEFT JOIN credentials tc ON a.target_type = 'credential' AND tc.id = a.target_id
         LEFT JOIN sessions tsn ON a.target_type = 'session' AND tsn.id = a.target_id
         ${where.sql}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...where.params, page.limit, page.offset) as Array<{
    id: string;
    type: string;
    actor_user_id: string | null;
    actor_name: string | null;
    target_type: string | null;
    target_id: string | null;
    target_name: string | null;
    detail_json: string | null;
    ip: string | null;
    user_agent: string | null;
    created_at: number;
  }>;
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      type: r.type,
      actorId: r.actor_user_id,
      actorName: r.actor_name,
      targetType: r.target_type,
      targetId: r.target_id,
      targetName: r.target_name,
      detail: parseDetail(r.detail_json),
      ip: r.ip,
      userAgent: r.user_agent,
      createdAt: r.created_at,
    })),
  };
}

/** Distinct event types present in the log (for the type filter). Admins only. */
export function listAuditTypes(db: TermavoxDb, viewer: AuditViewer): string[] {
  assertAdmin(viewer);
  const rows = db.$client
    .prepare('SELECT DISTINCT type FROM audit_events ORDER BY type')
    .all() as Array<{ type: string }>;
  return rows.map((r) => r.type);
}
