import '../server-guard.ts';
import type { TermavoxDb } from '@termavox/db';
import type { ProtectionMode } from '@termavox/protocol';
import { normalizeHostname, uuidv7 } from '@termavox/shared';
import { insertAuditEvent } from './audit.ts';

/**
 * User-scoped servers (plan D-29, §9: web owns `servers`; §10.2 isolation). A server holds what
 * an `ssh user@host` command line would: name, address, port, user name, credential (or none)
 * and the session options. Every statement filters on `user_id = ?`, so another user's server
 * behaves exactly like a missing one, and the credential a server points at must belong to the
 * same user (checked in the write's own transaction). Every write records its `server.*` audit
 * row in the same transaction. Host keys are read here; the daemon writes them.
 */

export type ServerKind = 'ssh' | 'local';

export interface ServerOptions {
  protectionMode: ProtectionMode;
  startupCommand: string | null;
  env: Record<string, string>;
  keepaliveIntervalS: number;
  autoReopen: boolean;
  scrollbackLines: number;
}

/**
 * A server as the forms produce it. `kind: local` (direct mode) has no address, user name or
 * credential: the repository stores nulls for them whatever is passed.
 */
export interface ServerInput extends ServerOptions {
  name: string;
  kind: ServerKind;
  hostname: string | null;
  port: number | null;
  username: string | null;
  /** Null: no stored secret, the server prompts in the terminal. */
  credentialId: string | null;
}

export interface Server extends ServerInput {
  id: string;
  credentialName: string | null;
  /** Sessions from this server that have not ended (they block a delete). */
  liveSessionCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Request facts for the audit row (public data only). */
export interface AuditMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export type ServerWriteOutcome = 'ok' | 'not_found' | 'credential_not_found';
export type DeleteOutcome = 'deleted' | 'not_found' | 'conflict';

interface ServerRow {
  id: string;
  name: string;
  kind: string;
  hostname: string | null;
  port: number | null;
  username: string | null;
  credential_id: string | null;
  credential_name: string | null;
  protection_mode: string;
  startup_command: string | null;
  env_json: string;
  keepalive_interval_s: number;
  auto_reopen: number;
  scrollback_lines: number;
  live_count: number;
  created_at: number;
  updated_at: number;
}

const SELECT_SERVER = `
  SELECT s.id, s.name, s.kind, s.hostname, s.port, s.username, s.credential_id,
         c.name AS credential_name, s.protection_mode, s.startup_command, s.env_json,
         s.keepalive_interval_s, s.auto_reopen, s.scrollback_lines, s.created_at, s.updated_at,
         (SELECT COUNT(*) FROM sessions x
           WHERE x.server_id = s.id AND x.user_id = s.user_id AND x.state <> 'ended') AS live_count
    FROM servers s
    LEFT JOIN credentials c ON c.id = s.credential_id AND c.user_id = s.user_id`;

function parseEnv(json: string): Record<string, string> {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function toServer(row: ServerRow): Server {
  const kind: ServerKind = row.kind === 'local' ? 'local' : 'ssh';
  return {
    id: row.id,
    name: row.name,
    kind,
    hostname: row.hostname,
    port: row.port,
    username: row.username,
    credentialId: row.credential_id,
    credentialName: row.credential_name,
    protectionMode: row.protection_mode === 'off' ? 'off' : 'auto',
    startupCommand: row.startup_command,
    env: parseEnv(row.env_json),
    keepaliveIntervalS: row.keepalive_interval_s,
    autoReopen: row.auto_reopen !== 0,
    scrollbackLines: row.scrollback_lines,
    liveSessionCount: row.live_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The columns as stored: a local server keeps no target; an address is stored normalized. */
function stored(input: ServerInput) {
  const local = input.kind === 'local';
  return {
    name: input.name,
    kind: input.kind,
    hostname: local || input.hostname === null ? null : normalizeHostname(input.hostname),
    port: local ? null : input.port,
    username: local ? null : input.username,
    credentialId: local ? null : input.credentialId,
  };
}

function auditDetail(row: ReturnType<typeof stored>) {
  return {
    name: row.name,
    kind: row.kind,
    hostname: row.hostname,
    port: row.port,
    username: row.username,
  };
}

function ownsCredential(db: TermavoxDb, userId: string, credentialId: string | null): boolean {
  if (credentialId === null) return true;
  return (
    db.$client
      .prepare('SELECT 1 FROM credentials WHERE id = ? AND user_id = ?')
      .get(credentialId, userId) !== undefined
  );
}

/** How many servers the user owns (drives the first-run state). */
export function countServers(db: TermavoxDb, userId: string): number {
  const row = db.$client
    .prepare('SELECT COUNT(*) AS total FROM servers WHERE user_id = ?')
    .get(userId) as { total: number };
  return row.total;
}

/** The user's servers, by name. */
export function listServers(db: TermavoxDb, userId: string): Server[] {
  const rows = db.$client
    .prepare(`${SELECT_SERVER} WHERE s.user_id = ? ORDER BY s.name COLLATE NOCASE, s.id`)
    .all(userId) as ServerRow[];
  return rows.map(toServer);
}

/** One of the user's servers, or null (also for another user's id: the duplicate source too). */
export function getServer(db: TermavoxDb, userId: string, serverId: string): Server | null {
  const row = db.$client
    .prepare(`${SELECT_SERVER} WHERE s.id = ? AND s.user_id = ?`)
    .get(serverId, userId) as ServerRow | undefined;
  return row ? toServer(row) : null;
}

export function createServer(
  db: TermavoxDb,
  userId: string,
  input: ServerInput,
  meta: AuditMeta = {},
  now: number = Date.now(),
): { outcome: 'ok'; id: string } | { outcome: 'credential_not_found' } {
  const sqlite = db.$client;
  const row = stored(input);
  return sqlite.transaction(() => {
    if (!ownsCredential(db, userId, row.credentialId)) {
      return { outcome: 'credential_not_found' as const };
    }
    const id = uuidv7(now);
    sqlite
      .prepare(
        `INSERT INTO servers
           (id, user_id, name, kind, hostname, port, username, credential_id, protection_mode,
            startup_command, env_json, keepalive_interval_s, auto_reopen, scrollback_lines,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        row.name,
        row.kind,
        row.hostname,
        row.port,
        row.username,
        row.credentialId,
        input.protectionMode,
        input.startupCommand,
        JSON.stringify(input.env),
        input.keepaliveIntervalS,
        input.autoReopen ? 1 : 0,
        input.scrollbackLines,
        now,
        now,
      );
    insertAuditEvent(db, {
      type: 'server.create',
      actorUserId: userId,
      targetType: 'server',
      targetId: id,
      detail: auditDetail(row),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      at: now,
    });
    return { outcome: 'ok' as const, id };
  })();
}

/**
 * Edits are always allowed: running sessions keep the target they snapshotted, and the daemon
 * reads the policies live (plan §9).
 */
export function updateServer(
  db: TermavoxDb,
  userId: string,
  serverId: string,
  input: ServerInput,
  meta: AuditMeta = {},
  now: number = Date.now(),
): ServerWriteOutcome {
  const sqlite = db.$client;
  const row = stored(input);
  return sqlite.transaction((): ServerWriteOutcome => {
    const found = sqlite
      .prepare('SELECT 1 FROM servers WHERE id = ? AND user_id = ?')
      .get(serverId, userId);
    if (!found) return 'not_found';
    if (!ownsCredential(db, userId, row.credentialId)) return 'credential_not_found';
    sqlite
      .prepare(
        `UPDATE servers
            SET name = ?, kind = ?, hostname = ?, port = ?, username = ?, credential_id = ?,
                protection_mode = ?, startup_command = ?, env_json = ?, keepalive_interval_s = ?,
                auto_reopen = ?, scrollback_lines = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`,
      )
      .run(
        row.name,
        row.kind,
        row.hostname,
        row.port,
        row.username,
        row.credentialId,
        input.protectionMode,
        input.startupCommand,
        JSON.stringify(input.env),
        input.keepaliveIntervalS,
        input.autoReopen ? 1 : 0,
        input.scrollbackLines,
        now,
        serverId,
        userId,
      );
    insertAuditEvent(db, {
      type: 'server.update',
      actorUserId: userId,
      targetType: 'server',
      targetId: serverId,
      detail: auditDetail(row),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      at: now,
    });
    return 'ok';
  })();
}

/**
 * Deletes a server. Rejected while a non-ended session came from it (plan §8.2: 409), checked in
 * the same transaction. Its host-key decisions stay: they belong to the address, not the server.
 */
export function deleteServer(
  db: TermavoxDb,
  userId: string,
  serverId: string,
  meta: AuditMeta = {},
  now: number = Date.now(),
): DeleteOutcome {
  const sqlite = db.$client;
  return sqlite.transaction((): DeleteOutcome => {
    const found = sqlite
      .prepare(
        'SELECT name, kind, hostname, port, username FROM servers WHERE id = ? AND user_id = ?',
      )
      .get(serverId, userId) as
      | {
          name: string;
          kind: ServerKind;
          hostname: string | null;
          port: number | null;
          username: string | null;
        }
      | undefined;
    if (!found) return 'not_found';
    const live = sqlite
      .prepare(
        "SELECT 1 FROM sessions WHERE server_id = ? AND user_id = ? AND state <> 'ended' LIMIT 1",
      )
      .get(serverId, userId);
    if (live) return 'conflict';
    sqlite.prepare('DELETE FROM servers WHERE id = ? AND user_id = ?').run(serverId, userId);
    insertAuditEvent(db, {
      type: 'server.delete',
      actorUserId: userId,
      targetType: 'server',
      targetId: serverId,
      detail: {
        name: found.name,
        kind: found.kind,
        hostname: found.hostname,
        port: found.port,
        username: found.username,
      },
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      at: now,
    });
    return 'deleted';
  })();
}

/** How many of the user's servers share this address (a host-key decision covers all of them). */
export function countServersAtAddress(
  db: TermavoxDb,
  userId: string,
  hostname: string,
  port: number,
): number {
  const row = db.$client
    .prepare(
      "SELECT COUNT(*) AS total FROM servers WHERE user_id = ? AND kind = 'ssh' AND hostname = ? AND port = ?",
    )
    .get(userId, normalizeHostname(hostname), port) as { total: number };
  return row.total;
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

/**
 * The user's host keys for this server's address (trusted first), without expired pending ones:
 * the same list for every server of the user with that hostname and port. Empty for another
 * user's server, for a local server, and for another user's decisions on the same address.
 */
export function listServerHostKeys(
  db: TermavoxDb,
  userId: string,
  serverId: string,
  now: number = Date.now(),
): HostKey[] {
  const rows = db.$client
    .prepare(
      `SELECT k.id, k.key_type, k.fingerprint_sha256, k.status, k.first_seen_at, k.decided_at
         FROM known_host_keys k
         JOIN servers s
           ON s.id = ? AND s.user_id = ? AND s.kind = 'ssh'
          AND k.user_id = s.user_id AND k.hostname = s.hostname AND k.port = s.port
        WHERE k.status <> 'pending' OR k.first_seen_at > ?
        ORDER BY CASE k.status WHEN 'trusted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                 COALESCE(k.decided_at, k.first_seen_at) DESC`,
    )
    .all(serverId, userId, now - PENDING_KEY_TTL_MS) as Array<{
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
