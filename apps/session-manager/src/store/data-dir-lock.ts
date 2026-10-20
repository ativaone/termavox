import { dirname, join } from 'node:path';
import { type FileLock, tryFileLock } from '@termavox/db';

/** The lock file, next to the database (`<data dir>/session-manager.lock`). */
export const DATA_DIR_LOCK_NAME = 'session-manager.lock';

export function dataDirLockFile(dbFile: string): string {
  return join(dirname(dbFile), DATA_DIR_LOCK_NAME);
}

/** The data directory is in use by a running session-manager or a maintenance command. */
export class DataDirLockedError extends Error {
  readonly lockFile: string;

  constructor(lockFile: string) {
    super(
      `${dirname(lockFile)} is in use by a running session-manager or by vault rotate ` +
        `(${lockFile} is locked)`,
    );
    this.name = 'DataDirLockedError';
    this.lockFile = lockFile;
  }
}

/**
 * Takes the data directory lock: session-manager holds it from the first boot step until its
 * shutdown completes, and `vault rotate` holds it while it runs, so neither starts while the
 * other uses the database. The lock dies with its process (see `tryFileLock`): a crashed daemon
 * never blocks the next one. web does not take it: it never writes credential ciphertexts or the
 * vault key check, and the rotation's single write transaction serializes web's other writes.
 */
export function lockDataDir(dbFile: string): FileLock {
  const file = dataDirLockFile(dbFile);
  let lock: FileLock | null;
  try {
    lock = tryFileLock(file);
  } catch (err) {
    // E.g. a lock file another user owns, or one that is not a SQLite file: name it.
    throw new Error(`cannot take the data directory lock ${file}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (!lock) throw new DataDirLockedError(file);
  return lock;
}
