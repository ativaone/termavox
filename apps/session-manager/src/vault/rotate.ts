import type { KeyObject } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type FileLock, openDb } from '@termdock/db';
import { DataDirLockedError, lockDataDir } from '../store/data-dir-lock.ts';
import { readSetting, SETTING_VAULT_KEY_CHECK } from '../store/settings.ts';
import { allRows, execute, getRow, parseJson, type Sqlite } from '../store/sqlite.ts';
import { VaultError } from './master-key.ts';
import {
  type CredentialBinding,
  type CredentialKind,
  type KeyCheck,
  KeyCheckMismatchError,
  parseKeyCheck,
  type SealedSecret,
  Vault,
} from './vault.ts';

/**
 * `vault rotate` (plan §10.2): re-encrypts every credential and the vault key check under a new
 * KEK, as key version N + 1 (the daemon opens the vault at the key check's version).
 *
 * 1. Refuses equal keys and a data directory whose lock is held (a running session-manager, see
 *    store/data-dir-lock.ts); then holds that lock itself until it is done, so session-manager
 *    cannot start meanwhile.
 * 2. Verifies the old key against `vault_key_check` before anything else. When the new key
 *    matches instead, the rotation already happened and nothing is done.
 * 3. Writes a consistent copy of the database next to it (`VACUUM INTO`,
 *    `pre-rotate-<UTC timestamp>.db`, mode 0600), synced to disk and integrity-checked.
 * 4. In one `BEGIN IMMEDIATE` transaction: re-encrypts every row (each must authenticate under
 *    the old key at its own key version) with a fresh nonce, replaces the key check, verifies
 *    every row and the check under the new key, and commits with `synchronous = FULL`. Any
 *    failure rolls the whole transaction back.
 *
 * A dry run verifies the old key and re-encrypts every row in memory only: it writes nothing,
 * not even the backup. Plaintext only ever sits in buffers the vault zeroes (`Vault.reseal`).
 */
export type RotateFailure =
  | 'equal-keys'
  | 'no-database'
  | 'locked'
  | 'no-key-check'
  | 'wrong-old-key'
  | 'already-rotated'
  | 'credential-invalid'
  | 'backup-failed'
  | 'aborted';

/** A refused or failed rotation; the database is unchanged. Messages never hold key material. */
export class RotateError extends Error {
  readonly reason: RotateFailure;
  /** The pre-rotate backup, when one was written before the failure (it is kept). */
  readonly backupFile: string | null;

  constructor(reason: RotateFailure, message: string, backupFile: string | null = null) {
    super(message);
    this.name = 'RotateError';
    this.reason = reason;
    this.backupFile = backupFile;
  }
}

export interface RotateOptions {
  /** Holds `app.db` (TERMDOCK_DATA_DIR). */
  dataDir: string;
  oldKey: KeyObject;
  newKey: KeyObject;
  dryRun?: boolean;
  /** Clock of the backup name (tests). */
  now?: () => Date;
}

export interface RotateResult {
  dbFile: string;
  dryRun: boolean;
  fromVersion: number;
  toVersion: number;
  /** Credentials re-encrypted (or, in a dry run, that would be). */
  credentials: number;
  byKind: Record<CredentialKind, number>;
  /** Null in a dry run. */
  backupFile: string | null;
}

/** SQLite's wait for web's write lock before BEGIN IMMEDIATE gives up (web keeps 5 s too). */
export const ROTATE_BUSY_TIMEOUT_MS = 5_000;
const MAX_KEY_VERSION = 0xffff_ffff; // the AAD encodes it as a u32
const BACKUP_PREFIX = 'pre-rotate-';

interface CredentialRow {
  id: string;
  user_id: string;
  kind: string;
  ciphertext: Buffer;
  nonce: Buffer;
  key_version: number;
}

export function rotateVault(options: RotateOptions): RotateResult {
  if (options.oldKey.equals(options.newKey)) {
    throw new RotateError(
      'equal-keys',
      'the old and new keys are the same: generate a new key (openssl rand -base64 32)',
    );
  }
  const dbFile = join(options.dataDir, 'app.db');
  if (!existsSync(dbFile)) throw new RotateError('no-database', `no database at ${dbFile}`);
  let lock: FileLock;
  try {
    lock = lockDataDir(dbFile);
  } catch (err) {
    if (!(err instanceof DataDirLockedError)) throw err;
    throw new RotateError('locked', `${err.message}: stop session-manager first`);
  }
  try {
    const db = openDb(dbFile, { busyTimeoutMs: ROTATE_BUSY_TIMEOUT_MS });
    try {
      return rotateOpenDb(db.$client, dbFile, options);
    } finally {
      db.$client.close();
    }
  } finally {
    lock.release();
  }
}

function rotateOpenDb(sqlite: Sqlite, dbFile: string, options: RotateOptions): RotateResult {
  const dryRun = options.dryRun ?? false;
  const { check, stored } = currentKeyCheck(sqlite);
  const fromVersion = check.keyVersion;
  if (fromVersion >= MAX_KEY_VERSION) {
    throw new VaultError(`key version ${fromVersion} cannot be incremented`);
  }
  const toVersion = fromVersion + 1;
  const oldVault = new Vault(new Map([[fromVersion, options.oldKey]]), fromVersion);
  const newVault = new Vault(new Map([[toVersion, options.newKey]]), toVersion);
  if (!matches(oldVault, check)) {
    if (matches(new Vault(new Map([[fromVersion, options.newKey]]), fromVersion), check)) {
      throw new RotateError(
        'already-rotated',
        `the database already uses the new key (vault_key_check matches it at key version ` +
          `${fromVersion}): there is nothing to rotate; install the new key file`,
      );
    }
    throw new RotateError(
      'wrong-old-key',
      'the old key does not match this database (vault_key_check failed): pass the key ' +
        'session-manager uses now (TERMDOCK_MASTER_KEY_FILE)',
    );
  }

  if (dryRun) {
    // A read transaction: one consistent view of the rows.
    sqlite.exec('BEGIN');
    try {
      const { byKind, credentials } = resealAll(sqlite, oldVault, newVault, null);
      return { dbFile, dryRun, fromVersion, toVersion, credentials, byKind, backupFile: null };
    } finally {
      sqlite.exec('ROLLBACK');
    }
  }

  const backupFile = writeBackup(sqlite, dbFile, options.now?.() ?? new Date());
  // The commit must be on disk before anyone swaps the key files.
  sqlite.pragma('synchronous = FULL');
  let counts: { byKind: Record<CredentialKind, number>; credentials: number };
  try {
    sqlite.exec('BEGIN IMMEDIATE'); // waits up to ROTATE_BUSY_TIMEOUT_MS for web's writes
    counts = resealAll(sqlite, oldVault, newVault, backupFile);
    // Compare-and-swap: the check must still be the one the old key was verified against.
    const replaced = execute(
      sqlite,
      'UPDATE instance_settings SET value_json = ?, updated_at = ? WHERE key = ? AND value_json = ?',
      JSON.stringify(newVault.createKeyCheck()),
      Date.now(),
      SETTING_VAULT_KEY_CHECK,
      stored,
    );
    if (replaced !== 1) {
      throw new RotateError(
        'aborted',
        'rotation aborted: vault_key_check changed during the rotation',
        backupFile,
      );
    }
    verifyRotated(sqlite, newVault, counts.credentials, backupFile);
    sqlite.exec('COMMIT');
  } catch (err) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
    if (err instanceof RotateError) throw err;
    throw new RotateError('aborted', `rotation aborted: ${(err as Error).message}`, backupFile);
  }
  // Fold the WAL into the database file; readers (web) may keep part of it for later.
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // The commit is already durable in the WAL.
  }
  return { dbFile, dryRun, fromVersion, toVersion, ...counts, backupFile };
}

/** The parsed key check and its stored JSON text. */
function currentKeyCheck(sqlite: Sqlite): { check: KeyCheck; stored: string } {
  const row = getRow<{ value_json: string }>(
    sqlite,
    'SELECT value_json FROM instance_settings WHERE key = ?',
    SETTING_VAULT_KEY_CHECK,
  );
  if (!row) {
    throw new RotateError(
      'no-key-check',
      'this database has no vault_key_check: session-manager has not started on it yet, so ' +
        'there is no key to rotate',
    );
  }
  return { check: parseKeyCheck(parseJson(row.value_json)), stored: row.value_json };
}

/** True when the vault's key decrypts the check; false on a mismatch only. */
function matches(vault: Vault, check: KeyCheck): boolean {
  try {
    vault.verifyKeyCheck(check);
    return true;
  } catch (err) {
    if (err instanceof KeyCheckMismatchError) return false;
    throw err;
  }
}

function credentialKind(kind: string): CredentialKind | null {
  return kind === 'password' || kind === 'private_key' ? kind : null;
}

/**
 * Re-encrypts every credential row for `target`; writes each one back when `backupFile` is set
 * (inside the caller's transaction), keeps the results in memory otherwise (dry run). Every row
 * is tried, and all the ones that do not authenticate are reported together.
 */
function resealAll(
  sqlite: Sqlite,
  source: Vault,
  target: Vault,
  backupFile: string | null,
): { byKind: Record<CredentialKind, number>; credentials: number } {
  const rows = allRows<CredentialRow>(
    sqlite,
    'SELECT id, user_id, kind, ciphertext, nonce, key_version FROM credentials ORDER BY id',
  );
  const byKind: Record<CredentialKind, number> = { password: 0, private_key: 0 };
  const failures: string[] = [];
  for (const row of rows) {
    const kind = credentialKind(row.kind);
    if (!kind) {
      failures.push(`${row.id} (unknown kind)`);
      continue;
    }
    const binding: CredentialBinding = { credentialId: row.id, userId: row.user_id, kind };
    let resealed: SealedSecret;
    try {
      resealed = source.reseal(binding, sealedOf(row), target);
    } catch (err) {
      failures.push(`${row.id} (${err instanceof VaultError ? err.message : 'malformed record'})`);
      continue;
    }
    byKind[kind] += 1;
    if (backupFile === null) continue;
    const changed = execute(
      sqlite,
      'UPDATE credentials SET ciphertext = ?, nonce = ?, key_version = ? WHERE id = ?',
      resealed.ciphertext,
      resealed.nonce,
      resealed.keyVersion,
      row.id,
    );
    if (changed !== 1) failures.push(`${row.id} (not updated)`);
  }
  if (failures.length > 0) {
    throw new RotateError(
      'credential-invalid',
      `${failures.length} of ${rows.length} credentials do not decrypt with the old key: ` +
        failures.join(', '),
      backupFile,
    );
  }
  return { byKind, credentials: rows.length };
}

function sealedOf(row: CredentialRow): SealedSecret {
  if (!Buffer.isBuffer(row.ciphertext) || !Buffer.isBuffer(row.nonce)) {
    throw new VaultError('sealed record is malformed');
  }
  return { ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.key_version };
}

/** Before COMMIT: every row and the key check must open with the new key at the new version. */
function verifyRotated(sqlite: Sqlite, vault: Vault, expected: number, backupFile: string): void {
  function fail(what: string): never {
    throw new RotateError('aborted', `rotation aborted: ${what}`, backupFile);
  }
  const rows = allRows<CredentialRow>(
    sqlite,
    'SELECT id, user_id, kind, ciphertext, nonce, key_version FROM credentials',
  );
  if (rows.length !== expected) fail('the credential count changed during the rotation');
  for (const row of rows) {
    const kind = credentialKind(row.kind);
    if (!kind || row.key_version !== vault.currentVersion) fail(`credential ${row.id} not rotated`);
    try {
      vault.verify({ credentialId: row.id, userId: row.user_id, kind }, sealedOf(row));
    } catch {
      fail(`credential ${row.id} does not open with the new key`);
    }
  }
  try {
    vault.verifyKeyCheck(readSetting(sqlite, SETTING_VAULT_KEY_CHECK));
  } catch {
    fail('the new vault_key_check does not verify');
  }
}

function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * `VACUUM INTO` a new file next to the database: a consistent snapshot (one read transaction)
 * that includes the WAL. The file is created first (exclusively, mode 0600), since SQLite
 * accepts an empty target, then synced, as `VACUUM INTO` itself never syncs.
 */
function writeBackup(sqlite: Sqlite, dbFile: string, now: Date): string {
  const dir = dirname(dbFile);
  const file = join(dir, `${BACKUP_PREFIX}${utcStamp(now)}.db`);
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (err) {
    throw new RotateError(
      'backup-failed',
      `cannot create the backup ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  }
  try {
    chmodSync(file, 0o600);
    sqlite.prepare('VACUUM INTO ?').run(file);
    fsyncSync(fd);
  } catch (err) {
    throw new RotateError(
      'backup-failed',
      `the backup ${file} failed: ${(err as Error).message}`,
      file,
    );
  } finally {
    closeSync(fd);
  }
  syncDirectory(dir);
  // Uncached statements: they name the attached schema, which is gone after DETACH.
  sqlite.prepare('ATTACH DATABASE ? AS pre_rotate').run(file);
  try {
    const integrity = sqlite.prepare('PRAGMA pre_rotate.integrity_check').get() as
      | { integrity_check: string }
      | undefined;
    if (integrity?.integrity_check !== 'ok') {
      throw new RotateError('backup-failed', `the backup ${file} failed its integrity check`, file);
    }
  } finally {
    sqlite.exec('DETACH DATABASE pre_rotate');
  }
  return file;
}

function syncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every platform can sync a directory; the file itself is synced.
  }
}
