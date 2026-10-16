import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';
import { uuidv7 } from '@termdock/shared';
import type { DeleteOutcome } from './hosts.ts';

/**
 * User-scoped connection profiles (plan §9: web owns `connection_profiles`). Every statement
 * filters on `user_id = ?`; the host and the credential a profile points at must belong to the
 * same user, checked in the write's own transaction.
 */

export type ProtectionMode = 'auto' | 'off';

export interface ProfileInput {
  name: string;
  username: string;
  credentialId: string | null;
  protectionMode: ProtectionMode;
  startupCommand: string | null;
  env: Record<string, string>;
  keepaliveIntervalS: number;
  autoReopen: boolean;
  scrollbackLines: number;
}

export interface Profile extends ProfileInput {
  id: string;
  hostId: string;
  credentialName: string | null;
  liveSessionCount: number;
  createdAt: number;
  updatedAt: number;
}

interface ProfileRow {
  id: string;
  host_id: string;
  name: string;
  username: string;
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

const SELECT_PROFILE = `
  SELECT p.id, p.host_id, p.name, p.username, p.credential_id, c.name AS credential_name,
         p.protection_mode, p.startup_command, p.env_json, p.keepalive_interval_s, p.auto_reopen,
         p.scrollback_lines, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM sessions s
           WHERE s.profile_id = p.id AND s.user_id = p.user_id AND s.state <> 'ended') AS live_count
    FROM connection_profiles p
    LEFT JOIN credentials c ON c.id = p.credential_id AND c.user_id = p.user_id`;

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

function toProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    hostId: row.host_id,
    name: row.name,
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

export function listProfiles(db: TermdockDb, userId: string, hostId: string): Profile[] {
  const rows = db.$client
    .prepare(
      `${SELECT_PROFILE} WHERE p.user_id = ? AND p.host_id = ? ORDER BY p.name COLLATE NOCASE, p.id`,
    )
    .all(userId, hostId) as ProfileRow[];
  return rows.map(toProfile);
}

export function getProfile(db: TermdockDb, userId: string, profileId: string): Profile | null {
  const row = db.$client
    .prepare(`${SELECT_PROFILE} WHERE p.id = ? AND p.user_id = ?`)
    .get(profileId, userId) as ProfileRow | undefined;
  return row ? toProfile(row) : null;
}

/** Every profile of the user with its host name (the session palette's search list). */
export function listProfilesForUser(
  db: TermdockDb,
  userId: string,
): Array<{ id: string; name: string; username: string; hostId: string; hostName: string }> {
  return db.$client
    .prepare(
      `SELECT p.id, p.name, p.username, h.id AS hostId, h.name AS hostName
         FROM connection_profiles p
         JOIN hosts h ON h.id = p.host_id AND h.user_id = p.user_id
        WHERE p.user_id = ?
        ORDER BY h.name COLLATE NOCASE, p.name COLLATE NOCASE`,
    )
    .all(userId) as Array<{
    id: string;
    name: string;
    username: string;
    hostId: string;
    hostName: string;
  }>;
}

export type ProfileWriteOutcome = 'ok' | 'not_found' | 'credential_not_found';

function ownsCredential(db: TermdockDb, userId: string, credentialId: string | null): boolean {
  if (credentialId === null) return true;
  return (
    db.$client
      .prepare('SELECT 1 FROM credentials WHERE id = ? AND user_id = ?')
      .get(credentialId, userId) !== undefined
  );
}

export function createProfile(
  db: TermdockDb,
  userId: string,
  hostId: string,
  input: ProfileInput,
  now: number = Date.now(),
): { outcome: ProfileWriteOutcome; id?: string } {
  const sqlite = db.$client;
  return sqlite.transaction(() => {
    const host = sqlite
      .prepare('SELECT 1 FROM hosts WHERE id = ? AND user_id = ?')
      .get(hostId, userId);
    if (!host) return { outcome: 'not_found' as const };
    if (!ownsCredential(db, userId, input.credentialId)) {
      return { outcome: 'credential_not_found' as const };
    }
    const id = uuidv7(now);
    sqlite
      .prepare(
        `INSERT INTO connection_profiles
           (id, user_id, host_id, credential_id, name, username, protection_mode, startup_command,
            env_json, keepalive_interval_s, auto_reopen, scrollback_lines, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        hostId,
        input.credentialId,
        input.name,
        input.username,
        input.protectionMode,
        input.startupCommand,
        JSON.stringify(input.env),
        input.keepaliveIntervalS,
        input.autoReopen ? 1 : 0,
        input.scrollbackLines,
        now,
        now,
      );
    return { outcome: 'ok' as const, id };
  })();
}

/** Edits affect new sessions only; policies are read live by the daemon (plan §9). */
export function updateProfile(
  db: TermdockDb,
  userId: string,
  profileId: string,
  input: ProfileInput,
  now: number = Date.now(),
): ProfileWriteOutcome {
  const sqlite = db.$client;
  return sqlite.transaction((): ProfileWriteOutcome => {
    if (!ownsCredential(db, userId, input.credentialId)) return 'credential_not_found';
    const result = sqlite
      .prepare(
        `UPDATE connection_profiles
            SET credential_id = ?, name = ?, username = ?, protection_mode = ?,
                startup_command = ?, env_json = ?, keepalive_interval_s = ?, auto_reopen = ?,
                scrollback_lines = ?, updated_at = ?
          WHERE id = ? AND user_id = ?`,
      )
      .run(
        input.credentialId,
        input.name,
        input.username,
        input.protectionMode,
        input.startupCommand,
        JSON.stringify(input.env),
        input.keepaliveIntervalS,
        input.autoReopen ? 1 : 0,
        input.scrollbackLines,
        now,
        profileId,
        userId,
      );
    return result.changes > 0 ? 'ok' : 'not_found';
  })();
}

/** Rejected while a non-ended session was started from the profile (plan §8.2: 409). */
export function deleteProfile(db: TermdockDb, userId: string, profileId: string): DeleteOutcome {
  const sqlite = db.$client;
  return sqlite.transaction((): DeleteOutcome => {
    const found = sqlite
      .prepare('SELECT 1 FROM connection_profiles WHERE id = ? AND user_id = ?')
      .get(profileId, userId);
    if (!found) return 'not_found';
    const live = sqlite
      .prepare(
        "SELECT 1 FROM sessions WHERE profile_id = ? AND user_id = ? AND state <> 'ended' LIMIT 1",
      )
      .get(profileId, userId);
    if (live) return 'conflict';
    sqlite
      .prepare('DELETE FROM connection_profiles WHERE id = ? AND user_id = ?')
      .run(profileId, userId);
    return 'deleted';
  })();
}
