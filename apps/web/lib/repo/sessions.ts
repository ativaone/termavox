import '../server-guard.ts';
import type { TermavoxDb } from '@termavox/db';
import { Protection, SessionStatus } from '@termavox/protocol';
import { ENDED_SHOWN } from '../sessions/lanes.ts';
import type { BayData, BaySession } from '../sessions/types.ts';

/**
 * User-scoped reads for the workspace bay (plan §10.2 isolation). Every statement filters on
 * `sessions.user_id = ?`; the bay shows each session's snapshotted target (`user@host:port`),
 * never another row's data. Raw SQL on the shared better-sqlite3 handle, like
 * lib/auth/queries.ts (drizzle-orm is not a web dependency).
 */

interface SessionRow {
  id: string;
  label: string;
  notify: number;
  status: string;
  protection: string | null;
  kind: string;
  username: string;
  hostname: string;
  port: number;
  server_deleted: number;
  created_at: number;
  ended_at: number | null;
}

const SELECT = `
  SELECT s.id, s.label, s.notify, s.status, s.protection_effective AS protection,
         s.target_kind AS kind,
         s.target_username AS username, s.target_hostname AS hostname, s.target_port AS port,
         s.server_id IS NULL AS server_deleted, s.created_at, s.ended_at
  FROM sessions s`;

function toBaySession(row: SessionRow): BaySession {
  const status = SessionStatus.safeParse(row.status);
  const protection = Protection.safeParse(row.protection);
  return {
    id: row.id,
    label: row.label,
    notify: row.notify !== 0,
    // An unknown status is shown as Disconnected rather than overstated as healthy.
    status: status.success ? status.data : 'disconnected',
    protection: protection.success ? protection.data : null,
    kind: row.kind === 'local' ? 'local' : 'ssh',
    username: row.username,
    hostname: row.hostname,
    port: row.port,
    serverDeleted: row.server_deleted !== 0,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

/** The signed-in user's bay: all non-ended sessions (oldest first) and the latest ended ones. */
export function listBaySessions(db: TermavoxDb, userId: string): BayData {
  const sqlite = db.$client;
  const live = sqlite
    .prepare(`${SELECT} WHERE s.user_id = ? AND s.status <> 'ended' ORDER BY s.created_at, s.id`)
    .all(userId) as SessionRow[];
  const ended = sqlite
    .prepare(
      `${SELECT} WHERE s.user_id = ? AND s.status = 'ended'
       ORDER BY COALESCE(s.ended_at, s.created_at) DESC, s.id LIMIT ?`,
    )
    .all(userId, ENDED_SHOWN) as SessionRow[];
  const { total } = sqlite
    .prepare(`SELECT COUNT(*) AS total FROM sessions WHERE user_id = ? AND status = 'ended'`)
    .get(userId) as { total: number };
  return { sessions: [...live, ...ended].map(toBaySession), endedTotal: total };
}
