import { describe, expect, it } from 'vitest';
import { migrateDb, openDb, schema } from '../src/index.ts';

const server = (values: Partial<typeof schema.servers.$inferInsert>) => ({
  id: 's1',
  userId: 'u1',
  name: 'x',
  kind: 'ssh' as const,
  hostname: 'example',
  port: 22,
  username: 'deploy',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...values,
});

function migrated() {
  const db = openDb(':memory:');
  migrateDb(db);
  return db;
}

function withUser() {
  const db = migrated();
  db.insert(schema.user)
    .values({
      id: 'u1',
      name: 'u1',
      email: 'u1@example.test',
      username: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return db;
}

describe('db', () => {
  it('applies migrations and enforces foreign keys', () => {
    const db = migrated();
    expect(() =>
      db
        .insert(schema.servers)
        .values(server({ userId: 'missing' }))
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('requires an address, port and user name for an ssh server, none for a local one', () => {
    const db = withUser();
    for (const missing of [{ hostname: null }, { port: null }, { username: null }]) {
      expect(() => db.insert(schema.servers).values(server(missing)).run()).toThrow(/CHECK/);
    }
    db.insert(schema.servers)
      .values(server({ id: 'local', kind: 'local', hostname: null, port: null, username: null }))
      .run();
    db.insert(schema.servers)
      .values(server({ id: 'ssh' }))
      .run();
  });
});

describe('sessions.tmux_socket (plan D-30)', () => {
  const session = (values: Partial<typeof schema.sessions.$inferInsert>) => ({
    id: 'x1',
    userId: 'u1',
    serverId: 's1',
    targetKind: 'ssh' as const,
    targetHostname: 'example',
    targetPort: 22,
    targetUsername: 'deploy',
    term: 'xterm-256color',
    scrollbackLines: 5000,
    label: 'x',
    desiredState: 'running' as const,
    state: 'new',
    status: 'connecting',
    tmuxToken: 'abcdefghijkl',
    cols: 80,
    rows: 24,
    createdAt: new Date(),
    ...values,
  });

  it('is a nullable text column added by migration 0001: null by default, the full name when adopted', () => {
    const db = withUser();
    const columns = db.$client.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const column = columns.find((c) => c.name === 'tmux_socket');
    expect(column).toEqual(expect.objectContaining({ notnull: 0, dflt_value: null }));
    expect(column?.type.toLowerCase()).toBe('text');
    db.insert(schema.servers).values(server({})).run();
    db.insert(schema.sessions).values(session({})).run();
    db.insert(schema.sessions)
      .values(session({ id: 'x2', tmuxSocket: 'td-zzzzzzzz-abcdefghijkl' }))
      .run();
    const rows = db.$client
      .prepare('SELECT id, tmux_socket FROM sessions ORDER BY id')
      .all() as Array<{ id: string; tmux_socket: string | null }>;
    expect(rows).toEqual([
      { id: 'x1', tmux_socket: null },
      { id: 'x2', tmux_socket: 'td-zzzzzzzz-abcdefghijkl' },
    ]);
  });
});
