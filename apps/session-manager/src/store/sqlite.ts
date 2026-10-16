import type { TermdockDb } from '@termdock/db';

/**
 * The raw better-sqlite3 connection behind a `TermdockDb`. Daemon stores use prepared SQL over
 * it (session-manager depends on `@termdock/db` only, not on drizzle-orm's query operators);
 * the column names are the migration's (`packages/db/drizzle`). Timestamps are epoch ms
 * integers and booleans 0/1, as in the schema.
 */
export type Sqlite = TermdockDb['$client'];
const prepare = (sqlite: Sqlite, sql: string) => sqlite.prepare<unknown[], unknown>(sql);
export type Statement = ReturnType<typeof prepare>;

const cache = new WeakMap<Sqlite, Map<string, Statement>>();

/** A prepared statement, compiled once per connection. */
export function prepared(sqlite: Sqlite, sql: string): Statement {
  let statements = cache.get(sqlite);
  if (!statements) {
    statements = new Map();
    cache.set(sqlite, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = prepare(sqlite, sql);
    statements.set(sql, statement);
  }
  return statement;
}

export function getRow<T>(sqlite: Sqlite, sql: string, ...params: unknown[]): T | undefined {
  return prepared(sqlite, sql).get(...params) as T | undefined;
}

export function allRows<T>(sqlite: Sqlite, sql: string, ...params: unknown[]): T[] {
  return prepared(sqlite, sql).all(...params) as T[];
}

export function execute(sqlite: Sqlite, sql: string, ...params: unknown[]): number {
  return prepared(sqlite, sql).run(...params).changes;
}

/** Parses a JSON column; undefined when null or invalid. */
export function parseJson(value: string | null | undefined): unknown {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
