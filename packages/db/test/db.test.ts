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
