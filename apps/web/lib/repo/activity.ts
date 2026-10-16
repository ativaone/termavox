import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';
import { Protection, SessionStatus } from '@termdock/protocol';
import { parseDetail } from './audit.ts';

/**
 * The user's own session history and `session_events` (plan §8.1 /activity), newest first.
 * Every statement joins through `sessions.user_id = ?`. Events carry state and connection
 * metadata only; terminal input and output are never stored anywhere.
 */

export interface SessionEventRow {
  id: string;
  type: string;
  sessionId: string;
  sessionLabel: string;
  host: string;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: number;
}

export interface SessionHistoryRow {
  id: string;
  label: string;
  host: string;
  user: string;
  status: SessionStatus;
  protection: Protection | null;
  createdAt: number;
  endedAt: number | null;
  endReason: string | null;
}

export interface Page {
  limit: number;
  offset: number;
}

export function listSessionEvents(
  db: TermdockDb,
  userId: string,
  page: Page,
): { rows: SessionEventRow[]; total: number } {
  const sqlite = db.$client;
  const { total } = sqlite
    .prepare(
      `SELECT COUNT(*) AS total FROM session_events e
         JOIN sessions s ON s.id = e.session_id WHERE s.user_id = ?`,
    )
    .get(userId) as { total: number };
  const rows = sqlite
    .prepare(
      `SELECT e.id, e.type, e.session_id, s.label, COALESCE(h.name, s.target_hostname) AS host,
              e.detail_json, e.ip, e.created_at
         FROM session_events e
         JOIN sessions s ON s.id = e.session_id
         LEFT JOIN hosts h ON h.id = s.target_host_id AND h.user_id = s.user_id
        WHERE s.user_id = ?
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(userId, page.limit, page.offset) as Array<{
    id: string;
    type: string;
    session_id: string;
    label: string;
    host: string;
    detail_json: string | null;
    ip: string | null;
    created_at: number;
  }>;
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      type: r.type,
      sessionId: r.session_id,
      sessionLabel: r.label,
      host: r.host,
      detail: parseDetail(r.detail_json),
      ip: r.ip,
      createdAt: r.created_at,
    })),
  };
}

export function listSessionHistory(
  db: TermdockDb,
  userId: string,
  page: Page,
): { rows: SessionHistoryRow[]; total: number } {
  const sqlite = db.$client;
  const { total } = sqlite
    .prepare('SELECT COUNT(*) AS total FROM sessions WHERE user_id = ?')
    .get(userId) as { total: number };
  const rows = sqlite
    .prepare(
      `SELECT s.id, s.label, COALESCE(h.name, s.target_hostname) AS host, s.target_username AS user,
              s.status, s.protection_effective, s.created_at, s.ended_at, s.end_reason
         FROM sessions s
         LEFT JOIN hosts h ON h.id = s.target_host_id AND h.user_id = s.user_id
        WHERE s.user_id = ?
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(userId, page.limit, page.offset) as Array<{
    id: string;
    label: string;
    host: string;
    user: string;
    status: string;
    protection_effective: string | null;
    created_at: number;
    ended_at: number | null;
    end_reason: string | null;
  }>;
  return {
    total,
    rows: rows.map((r) => {
      const status = SessionStatus.safeParse(r.status);
      const protection = Protection.safeParse(r.protection_effective);
      return {
        id: r.id,
        label: r.label,
        host: r.host,
        user: r.user,
        status: status.success ? status.data : 'disconnected',
        protection: protection.success ? protection.data : null,
        createdAt: r.created_at,
        endedAt: r.ended_at,
        endReason: r.end_reason,
      };
    }),
  };
}
