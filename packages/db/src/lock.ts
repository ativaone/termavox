import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/** An exclusive advisory lock on a file, held until `release()` or the end of the process. */
export interface FileLock {
  readonly file: string;
  /** Idempotent. */
  release(): void;
}

/**
 * Takes an exclusive lock on `file` through SQLite's own file locking, or returns null when
 * another connection holds it, in this process or any other.
 *
 * The file is a tiny SQLite database that holds no data. A connection in
 * `locking_mode = EXCLUSIVE` that runs a write transaction keeps its exclusive lock until it
 * closes. On Unix these are POSIX record locks: the kernel drops them when the process exits,
 * however it exits (a crash, `kill -9`, an OOM kill), so a stale lock cannot outlive its holder,
 * and no pid needs checking. The locks are attached to the file itself, so they also hold
 * across PID namespaces: containers that mount the same volume on one host see each other's
 * locks, as with the WAL database that web and session-manager already share.
 *
 * An empty file is initialized first, in normal locking mode with the default rollback journal,
 * so a crash during that first write cannot leave a corrupt lock file. Taking the lock afterwards
 * changes no page, which keeps SQLite from writing (and leaving behind) a journal file.
 */
export function tryFileLock(file: string): FileLock | null {
  mkdirSync(dirname(file), { recursive: true });
  // timeout 0: fail at once when the lock is held instead of waiting for it.
  const db = new Database(file, { timeout: 0 });
  try {
    if (db.pragma('page_count', { simple: true }) === 0) {
      db.exec('BEGIN IMMEDIATE');
      db.pragma('user_version = 1');
      db.exec('COMMIT');
    }
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT'); // the exclusive lock stays: locking_mode = EXCLUSIVE
  } catch (err) {
    db.close();
    if ((err as { code?: unknown }).code === 'SQLITE_BUSY') return null;
    throw err;
  }
  return {
    file,
    release() {
      if (db.open) db.close();
    },
  };
}
