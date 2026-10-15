import { describe, expect, it } from 'vitest';
import { migrateDb, openDb, schema } from '../src/index.ts';

describe('db', () => {
  it('applies migrations and enforces foreign keys', () => {
    const db = openDb(':memory:');
    migrateDb(db);
    expect(() =>
      db
        .insert(schema.hosts)
        .values({
          id: 'h1',
          userId: 'missing',
          name: 'x',
          kind: 'ssh',
          hostname: 'example',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});
