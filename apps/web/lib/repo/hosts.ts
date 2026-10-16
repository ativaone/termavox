import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';
import { uuidv7 } from '@termdock/shared';

/**
 * User-scoped host reads and writes (plan §9: web owns `hosts`; §10.2 isolation). Every
 * statement filters on `user_id = ?`, so another user's host can be neither read nor changed:
 * it behaves exactly like a missing one. Host keys are read here (the daemon writes them).
 */

/** How many hosts the user owns (drives the first-run empty state). User-scoped by `user_id`. */
export function countHosts(db: TermdockDb, userId: string): number {
  const row = db.$client
    .prepare('SELECT COUNT(*) AS total FROM hosts WHERE user_id = ?')
    .get(userId) as {
    total: number;
  };
  return row.total;
}

export type HostKind = 'ssh' | 'local';

export interface HostSummary {
  id: string;
  name: string;
  kind: HostKind;
  hostname: string;
  port: number;
  profileCount: number;
  /** Sessions on this host that have not ended (they block a delete). */
  liveSessionCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface HostInput {
  name: string;
  kind: HostKind;
  hostname: string;
  port: number;
}

interface HostRow {
  id: string;
  name: string;
  kind: string;
  hostname: string;
  port: number;
  profile_count: number;
  live_count: number;
  created_at: number;
  updated_at: number;
}

const SELECT_HOST = `
  SELECT h.id, h.name, h.kind, h.hostname, h.port, h.created_at, h.updated_at,
         (SELECT COUNT(*) FROM connection_profiles p
           WHERE p.host_id = h.id AND p.user_id = h.user_id) AS profile_count,
         (SELECT COUNT(*) FROM sessions s
           WHERE s.target_host_id = h.id AND s.user_id = h.user_id AND s.state <> 'ended') AS live_count
    FROM hosts h`;

function toSummary(row: HostRow): HostSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'local' ? 'local' : 'ssh',
    hostname: row.hostname,
    port: row.port,
    profileCount: row.profile_count,
    liveSessionCount: row.live_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listHosts(db: TermdockDb, userId: string): HostSummary[] {
  const rows = db.$client
    .prepare(`${SELECT_HOST} WHERE h.user_id = ? ORDER BY h.name COLLATE NOCASE, h.id`)
    .all(userId) as HostRow[];
  return rows.map(toSummary);
}

export function getHost(db: TermdockDb, userId: string, hostId: string): HostSummary | null {
  const row = db.$client
    .prepare(`${SELECT_HOST} WHERE h.id = ? AND h.user_id = ?`)
    .get(hostId, userId) as HostRow | undefined;
  return row ? toSummary(row) : null;
}

export function createHost(
  db: TermdockDb,
  userId: string,
  input: HostInput,
  now: number = Date.now(),
): string {
  const id = uuidv7(now);
  db.$client
    .prepare(
      `INSERT INTO hosts (id, user_id, name, kind, hostname, port, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, input.name, input.kind, input.hostname, input.port, now, now);
  return id;
}

/** Edits are always allowed: running sessions keep the target they snapshotted (plan §9). */
export function updateHost(
  db: TermdockDb,
  userId: string,
  hostId: string,
  input: HostInput,
  now: number = Date.now(),
): boolean {
  const result = db.$client
    .prepare(
      `UPDATE hosts SET name = ?, kind = ?, hostname = ?, port = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    )
    .run(input.name, input.kind, input.hostname, input.port, now, hostId, userId);
  return result.changes > 0;
}

export type DeleteOutcome = 'deleted' | 'not_found' | 'conflict';

/**
 * Deletes a host with its profiles and keys (cascade). Rejected while a non-ended session targets
 * it (plan §8.2: 409), checked in the same transaction as the delete.
 */
export function deleteHost(db: TermdockDb, userId: string, hostId: string): DeleteOutcome {
  const sqlite = db.$client;
  return sqlite.transaction((): DeleteOutcome => {
    const host = sqlite
      .prepare('SELECT id FROM hosts WHERE id = ? AND user_id = ?')
      .get(hostId, userId);
    if (!host) return 'not_found';
    const live = sqlite
      .prepare(
        `SELECT 1 FROM sessions
          WHERE user_id = ? AND state <> 'ended'
            AND (target_host_id = ?
                 OR profile_id IN (SELECT id FROM connection_profiles WHERE host_id = ?))
          LIMIT 1`,
      )
      .get(userId, hostId, hostId);
    if (live) return 'conflict';
    sqlite.prepare('DELETE FROM hosts WHERE id = ? AND user_id = ?').run(hostId, userId);
    return 'deleted';
  })();
}

export type HostKeyStatus = 'trusted' | 'pending' | 'revoked';

export interface HostKey {
  id: string;
  keyType: string;
  fingerprint: string;
  status: HostKeyStatus;
  firstSeenAt: number;
  decidedAt: number | null;
}

/** Pending keys expire 24 h after they were first seen (plan §5.9). */
export const PENDING_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** The host's keys (trusted first), without expired pending ones; empty for a foreign host. */
export function listHostKeys(
  db: TermdockDb,
  userId: string,
  hostId: string,
  now: number = Date.now(),
): HostKey[] {
  const rows = db.$client
    .prepare(
      `SELECT k.id, k.key_type, k.fingerprint_sha256, k.status, k.first_seen_at, k.decided_at
         FROM known_host_keys k
         JOIN hosts h ON h.id = k.host_id AND h.user_id = ?
        WHERE k.host_id = ? AND (k.status <> 'pending' OR k.first_seen_at > ?)
        ORDER BY CASE k.status WHEN 'trusted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                 COALESCE(k.decided_at, k.first_seen_at) DESC`,
    )
    .all(userId, hostId, now - PENDING_KEY_TTL_MS) as Array<{
    id: string;
    key_type: string;
    fingerprint_sha256: string;
    status: string;
    first_seen_at: number;
    decided_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    keyType: r.key_type,
    fingerprint: r.fingerprint_sha256,
    status: r.status === 'trusted' || r.status === 'pending' ? r.status : 'revoked',
    firstSeenAt: r.first_seen_at,
    decidedAt: r.decided_at,
  }));
}
