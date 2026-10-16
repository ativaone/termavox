/** Temp-file SQLite fixtures (migrations applied) shared by the store, vault and API tests. */
import { createSecretKey, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDb, openDb, type TermdockDb } from '@termdock/db';
import { uuidv7 } from '@termdock/shared';
import { Vault } from '../../src/vault/vault.ts';

export interface TempDb {
  dir: string;
  file: string;
  db: TermdockDb;
  /** Another connection to the same file. */
  open(busyTimeoutMs?: number): TermdockDb;
  cleanup(): void;
}

export function tempDb(busyTimeoutMs = 250): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'termdock-store-'));
  const file = join(dir, 'app.db');
  const db = openDb(file, { busyTimeoutMs });
  migrateDb(db);
  const extra: TermdockDb[] = [];
  return {
    dir,
    file,
    db,
    open(timeout = 250) {
      const other = openDb(file, { busyTimeoutMs: timeout });
      extra.push(other);
      return other;
    },
    cleanup() {
      for (const conn of [db, ...extra]) {
        if (conn.$client.open) conn.$client.close();
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function testVault(keyVersion = 1): Vault {
  return new Vault(new Map([[keyVersion, createSecretKey(randomBytes(32))]]), keyVersion);
}

export function insertUser(
  db: TermdockDb,
  opts: { role?: string; banned?: boolean; banExpires?: number | null } = {},
): string {
  const id = uuidv7();
  const now = Date.now();
  db.$client
    .prepare(
      `INSERT INTO user (id, name, email, role, banned, ban_expires, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      'user',
      `${id}@test`,
      opts.role ?? 'user',
      opts.banned ? 1 : 0,
      opts.banExpires ?? null,
      now,
      now,
    );
  return id;
}

export function insertHost(
  db: TermdockDb,
  userId: string,
  opts: { name?: string; kind?: 'ssh' | 'local'; port?: number } = {},
): string {
  const id = uuidv7();
  const now = Date.now();
  db.$client
    .prepare(
      `INSERT INTO hosts (id, user_id, name, kind, hostname, port, created_at, updated_at)
       VALUES (?, ?, ?, ?, '127.0.0.1', ?, ?, ?)`,
    )
    .run(id, userId, opts.name ?? 'test host', opts.kind ?? 'ssh', opts.port ?? 22, now, now);
  return id;
}

export function insertProfile(
  db: TermdockDb,
  userId: string,
  hostId: string,
  credentialId: string | null,
  opts: { username?: string; autoReopen?: boolean; protectionMode?: 'auto' | 'off' } = {},
): string {
  const id = uuidv7();
  const now = Date.now();
  db.$client
    .prepare(
      `INSERT INTO connection_profiles (id, user_id, host_id, credential_id, name, username,
         protection_mode, auto_reopen, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'test profile', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      hostId,
      credentialId,
      opts.username ?? 'td',
      opts.protectionMode ?? 'auto',
      opts.autoReopen === false ? 0 : 1,
      now,
      now,
    );
  return id;
}

export function insertAuthSession(db: TermdockDb, userId: string, expiresAt: number): string {
  const id = uuidv7();
  const now = Date.now();
  db.$client
    .prepare(
      `INSERT INTO auth_session (id, token, user_id, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, randomBytes(16).toString('hex'), userId, expiresAt, now, now);
  return id;
}

export function auditTypes(db: TermdockDb): string[] {
  return (
    db.$client.prepare('SELECT type FROM audit_events ORDER BY rowid').all() as Array<{
      type: string;
    }>
  ).map((r) => r.type);
}
