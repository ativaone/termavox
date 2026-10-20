import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema/index.ts';

export type TermavoxDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/**
 * Opens the shared SQLite database with the pragmas both processes rely on (plan §9).
 * session-manager passes a short busy timeout and retries through its batched writer, so a web
 * transaction never stalls the data plane; web keeps the 5 s default.
 */
export function openDb(file: string, opts: { busyTimeoutMs?: number } = {}): TermavoxDb {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
  return drizzle(sqlite, { schema }) as TermavoxDb;
}

/** Applies pending migrations. Only session-manager calls this at boot. */
export function migrateDb(db: TermavoxDb): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
