import { afterEach, describe, expect, it } from 'vitest';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import type { Sqlite } from '../../src/store/sqlite.ts';
import { type TempDb, tempDb } from './fixture.ts';

let fixture: TempDb;

function setup(busyTimeoutMs = 250): TempDb {
  fixture = tempDb(busyTimeoutMs);
  fixture.db.$client.exec('CREATE TABLE log (seq INTEGER PRIMARY KEY, op TEXT NOT NULL)');
  return fixture;
}

const insert = (op: string) => (sqlite: Sqlite) => {
  sqlite.prepare('INSERT INTO log (op) VALUES (?)').run(op);
};

function ops(sqlite: Sqlite): string[] {
  return (sqlite.prepare('SELECT op FROM log ORDER BY seq').all() as Array<{ op: string }>).map(
    (r) => r.op,
  );
}

afterEach(() => fixture?.cleanup());

describe('BatchedWriter', () => {
  it('coalesces consecutive updates of the same key and never across other ops', async () => {
    const { db } = setup();
    const writer = new BatchedWriter(db);
    let updateWrites = 0;
    const update = (sqlite: Sqlite, patch: object): void => {
      updateWrites++;
      insert(`update ${JSON.stringify(patch)}`)(sqlite);
    };
    writer.enqueueUpdate('session:a', { state: 'connecting' }, update);
    writer.enqueueUpdate('session:a', { state: 'ready', cols: 80 }, update);
    writer.enqueue('event', insert('event'));
    writer.enqueueUpdate('session:a', { rows: 24 }, update);
    expect(writer.pending('session:a')).toEqual({ state: 'ready', cols: 80, rows: 24 });
    expect(await writer.flush()).toBe(true);
    expect(updateWrites).toBe(2);
    expect(ops(db.$client)).toEqual([
      'update {"state":"ready","cols":80}',
      'event',
      'update {"rows":24}',
    ]);
    expect(writer.pending('session:a')).toBeUndefined();
  });

  it('keeps enqueue order across many short transactions and settles run() in order', async () => {
    const { db } = setup();
    const writer = new BatchedWriter(db, { maxBatch: 7 });
    const settled: number[] = [];
    const runs: Promise<void>[] = [];
    for (let i = 0; i < 60; i++) {
      if (i % 3 === 0) {
        runs.push(writer.run(`op ${i}`, insert(`op ${i}`)).then(() => void settled.push(i)));
      } else {
        writer.enqueue(`op ${i}`, insert(`op ${i}`));
      }
    }
    await writer.flush();
    await Promise.all(runs);
    expect(ops(db.$client)).toEqual(Array.from({ length: 60 }, (_, i) => `op ${i}`));
    expect(settled).toEqual([...settled].sort((a, b) => a - b));
    expect(writer.committedBatches).toBeGreaterThanOrEqual(9);
  });

  it('retries after SQLITE_BUSY from another connection without losing or reordering writes', async () => {
    const { db, open } = setup(20);
    const other = open(20).$client;
    const writer = new BatchedWriter(db, { retryBaseMs: 5, retryMaxMs: 40 });
    other.prepare('BEGIN IMMEDIATE').run(); // another process holds the write lock
    other.prepare('INSERT INTO log (op) VALUES (?)').run('other');
    writer.enqueue('w1', insert('w1'));
    const run = writer.run('w2', (sqlite) => {
      insert('w2')(sqlite);
      return 'committed';
    });
    writer.enqueueUpdate('k', { a: 1 }, (sqlite, p) => insert(`k ${JSON.stringify(p)}`)(sqlite));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(writer.pendingCount).toBe(3); // still queued: every attempt hit SQLITE_BUSY
    writer.enqueueUpdate('k', { b: 2 }, (sqlite, p) => insert(`k ${JSON.stringify(p)}`)(sqlite));
    other.prepare('COMMIT').run();
    expect(await writer.flush(2_000)).toBe(true);
    await expect(run).resolves.toBe('committed');
    expect(ops(db.$client)).toEqual(['other', 'w1', 'w2', 'k {"a":1,"b":2}']);
  });

  it('drops only an op that fails for a non-busy reason', async () => {
    const { db } = setup();
    const writer = new BatchedWriter(db);
    writer.enqueue('before', insert('before'));
    const bad = writer.run('bad', (sqlite) => {
      insert('bad')(sqlite);
      sqlite.prepare('INSERT INTO missing_table VALUES (1)').run();
    });
    writer.enqueue('after', insert('after'));
    await expect(bad).rejects.toThrow(/missing_table/);
    await writer.flush();
    expect(ops(db.$client)).toEqual(['before', 'after']);
  });

  it('writes through synchronously after close()', async () => {
    const { db } = setup();
    const writer = new BatchedWriter(db);
    writer.enqueue('a', insert('a'));
    expect(await writer.close()).toBe(true);
    writer.enqueue('late', insert('late'));
    expect(ops(db.$client)).toEqual(['a', 'late']);
  });
});
