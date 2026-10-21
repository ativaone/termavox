/** Temp-file SQLite fixtures (migrations applied) shared by the store, vault and API tests. */
import { createSecretKey, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDb, openDb, type TermavoxDb } from '@termavox/db';
import { uuidv7 } from '@termavox/shared';
import { Vault } from '../../src/vault/vault.ts';

export interface TempDb {
  dir: string;
  file: string;
  db: TermavoxDb;
  /** Another connection to the same file. */
  open(busyTimeoutMs?: number): TermavoxDb;
  cleanup(): void;
}

export function tempDb(busyTimeoutMs = 250): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'termavox-store-'));
  const file = join(dir, 'app.db');
  const db = openDb(file, { busyTimeoutMs });
  migrateDb(db);
  const extra: TermavoxDb[] = [];
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
  db: TermavoxDb,
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

export interface ServerOptions {
  name?: string;
  kind?: 'ssh' | 'local';
  /** Stored as given (web stores it normalized); ignored for `kind: local`. */
  hostname?: string;
  port?: number;
  username?: string;
  credentialId?: string | null;
  autoReopen?: boolean;
  protectionMode?: 'auto' | 'off';
  tmuxTerm?: 'auto' | 'xterm-256color';
}

/**
 * A server row (web-owned, plan D-29). Defaults: an ssh server 'test server' at 127.0.0.1:22 as
 * `tv`, without a credential. A local server has no address, user name or credential.
 */
export function insertServer(db: TermavoxDb, userId: string, opts: ServerOptions = {}): string {
  const id = uuidv7();
  const now = Date.now();
  const local = opts.kind === 'local';
  db.$client
    .prepare(
      `INSERT INTO servers (id, user_id, name, kind, hostname, port, username, credential_id,
         protection_mode, auto_reopen, tmux_term, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      opts.name ?? 'test server',
      local ? 'local' : 'ssh',
      local ? null : (opts.hostname ?? '127.0.0.1'),
      local ? null : (opts.port ?? 22),
      local ? null : (opts.username ?? 'tv'),
      local ? null : (opts.credentialId ?? null),
      opts.protectionMode ?? 'auto',
      opts.autoReopen === false ? 0 : 1,
      opts.tmuxTerm ?? 'auto',
      now,
      now,
    );
  return id;
}

export function insertAuthSession(db: TermavoxDb, userId: string, expiresAt: number): string {
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

export function auditTypes(db: TermavoxDb): string[] {
  return (
    db.$client.prepare('SELECT type FROM audit_events ORDER BY rowid').all() as Array<{
      type: string;
    }>
  ).map((r) => r.type);
}
