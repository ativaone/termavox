import { Writable } from 'node:stream';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EVENT_RETENTION_DAYS, loadDaemonConfig } from '../../src/config/config.ts';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import {
  DAY_MS,
  PURGE_INITIAL_DELAY_MS,
  PURGE_INTERVAL_MS,
  type PurgeOptions,
  type PurgeResult,
  purgeEvents,
  RetentionJob,
} from '../../src/store/retention.ts';
import { SqliteSessionStore } from '../../src/store/session-store.ts';
import type { Sqlite } from '../../src/store/sqlite.ts';
import { insertServer, insertUser, type TempDb, tempDb } from './fixture.ts';

const NOW = Date.UTC(2026, 9, 16, 12);
const CUTOFF = NOW - 180 * DAY_MS;
const OLD_AUDIT = 1203;
const OLD_SESSION = 620;
const SECRET_MARKER = 'row-content-marker';

let fixture: TempDb | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * A migrated temp DB with old rows (before CUTOFF) and recent ones (at CUTOFF and after) in both
 * tables. Audit rows mix web types (`auth.*`, `user.*`) and daemon types: the purge applies to
 * the table, whoever wrote the row.
 */
async function seeded(): Promise<{ db: TempDb['db']; sqlite: Sqlite; writer: BatchedWriter }> {
  fixture = tempDb();
  const { db } = fixture;
  const writer = new BatchedWriter(db);
  const store = new SqliteSessionStore(db, writer);
  const userId = insertUser(db);
  const serverId = insertServer(db, userId);
  const session = await store.createFromServer({
    actingUserId: userId,
    serverId,
    viewport: { cols: 80, rows: 24 },
    enableLocalShell: false,
  });
  const sqlite = db.$client;
  const audit = sqlite.prepare(
    `INSERT INTO audit_events (id, actor_user_id, type, target_type, target_id, detail_json, created_at)
     VALUES (?, ?, ?, 'user', ?, ?, ?)`,
  );
  const event = sqlite.prepare(
    `INSERT INTO session_events (id, session_id, type, detail_json, created_at)
     VALUES (?, ?, 'attached', ?, ?)`,
  );
  const types = ['auth.login_success', 'user.create', 'credential.create', 'host_key.trust'];
  const detail = JSON.stringify({ note: SECRET_MARKER });
  sqlite.transaction(() => {
    for (let i = 0; i < OLD_AUDIT; i++) {
      audit.run(`old-a-${i}`, userId, types[i % 4], userId, detail, CUTOFF - 1 - i * 60_000);
    }
    for (let i = 0; i < 5; i++) {
      audit.run(`new-a-${i}`, userId, types[i % 4], userId, detail, CUTOFF + i * 60_000);
    }
    for (let i = 0; i < OLD_SESSION; i++) {
      event.run(`old-e-${i}`, session.id, detail, CUTOFF - 1 - i * 60_000);
    }
    for (let i = 0; i < 4; i++) event.run(`new-e-${i}`, session.id, detail, CUTOFF + i * 60_000);
  })();
  return { db, sqlite, writer };
}

function count(sqlite: Sqlite, table: string, where = '1'): number {
  return (
    sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }
  ).n;
}

const older = `created_at < ${CUTOFF}`;

function stubPurge(): {
  calls: PurgeOptions[];
  purge: (options: PurgeOptions) => Promise<PurgeResult>;
} {
  const calls: PurgeOptions[] = [];
  return {
    calls,
    purge: async (options) => {
      calls.push(options);
      return { deleted: { audit_events: 0, session_events: 0 }, chunks: 1, complete: true };
    },
  };
}

describe('event retention purge (plan §10.2)', () => {
  it('deletes rows older than the cutoff in chunks, web audit rows included, and keeps the rest', async () => {
    const { sqlite, writer } = await seeded();
    const batchesBefore = writer.committedBatches;
    const result = await purgeEvents({ writer, cutoff: CUTOFF, chunkRows: 500 });
    // audit 500 + 500 + 203, session 500 + 120: one writer transaction per chunk.
    expect(result).toEqual({
      deleted: { audit_events: OLD_AUDIT, session_events: OLD_SESSION },
      chunks: 5,
      complete: true,
    });
    expect(writer.committedBatches - batchesBefore).toBe(5);
    expect(count(sqlite, 'audit_events', older)).toBe(0);
    expect(count(sqlite, 'session_events', older)).toBe(0);
    // Recent rows stay, the one exactly at the cutoff included (plus the session's own
    // `created` event, written now).
    expect(count(sqlite, 'audit_events', `id LIKE 'new-a-%'`)).toBe(5);
    expect(count(sqlite, 'session_events', `id LIKE 'new-e-%'`)).toBe(4);
    expect(count(sqlite, 'session_events', `type = 'created'`)).toBe(1);
    expect(count(sqlite, 'audit_events', `type LIKE 'auth.%'`)).toBe(2);
    // Nothing left: a second purge deletes nothing in one statement per table.
    expect(await purgeEvents({ writer, cutoff: CUTOFF, chunkRows: 500 })).toMatchObject({
      deleted: { audit_events: 0, session_events: 0 },
      chunks: 2,
    });
  });

  it('never purges host-key decisions, however old, even for an address no server uses (D-29)', async () => {
    const { sqlite, writer } = await seeded();
    sqlite
      .prepare(
        `INSERT INTO known_host_keys (id, user_id, hostname, port, key_type, fingerprint_sha256,
           status, first_seen_at, decided_at)
         VALUES ('old-revoked', (SELECT id FROM user LIMIT 1), 'gone.example', 22, 'ssh-ed25519',
           ?, 'revoked', ?, ?)`,
      )
      .run(`SHA256:${'G'.repeat(43)}`, CUTOFF - 400 * DAY_MS, CUTOFF - 300 * DAY_MS);
    expect(count(sqlite, 'servers', `hostname = 'gone.example'`)).toBe(0);
    await purgeEvents({ writer, cutoff: CUTOFF, chunkRows: 500 });
    expect(count(sqlite, 'known_host_keys')).toBe(1);
  });

  it('lets writes queued during a purge commit between its chunks', async () => {
    const { sqlite, writer } = await seeded();
    const order: string[] = [];
    const purge = purgeEvents({ writer, cutoff: CUTOFF, chunkRows: 100 }).then((result) => {
      order.push('purge done');
      return result;
    });
    const remaining = await writer.run('probe', (s) => count(s, 'audit_events', older));
    order.push('probe done');
    expect((await purge).complete).toBe(true);
    // The probe ran after the first chunk only, long before the purge's 20th and last chunk.
    expect(remaining).toBe(OLD_AUDIT - 100);
    expect(order).toEqual(['probe done', 'purge done']);
    expect(count(sqlite, 'audit_events', older)).toBe(0);
  });

  it('ends before the next chunk once stopped', async () => {
    const { sqlite, writer } = await seeded();
    let checks = 0;
    const result = await purgeEvents({
      writer,
      cutoff: CUTOFF,
      chunkRows: 500,
      stopped: () => checks++ >= 1,
    });
    expect(result).toEqual({
      deleted: { audit_events: 500, session_events: 0 },
      chunks: 1,
      complete: false,
    });
    expect(count(sqlite, 'audit_events', older)).toBe(OLD_AUDIT - 500);
    expect(count(sqlite, 'session_events', older)).toBe(OLD_SESSION);
  });

  it('finds old rows through a created_at index in both tables', async () => {
    const { sqlite } = await seeded();
    for (const table of ['audit_events', 'session_events']) {
      const plan = sqlite
        .prepare(
          `EXPLAIN QUERY PLAN SELECT rowid FROM ${table} WHERE created_at < ? ORDER BY created_at LIMIT ?`,
        )
        .all(CUTOFF, 500) as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(' | ')).toMatch(
        new RegExp(`USING (COVERING )?INDEX ${table}_created_idx`),
      );
    }
  });
});

describe('RetentionJob', () => {
  it('runs a few minutes after boot, then every 6 hours, with the cutoff from the clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = NOW;
    const { calls, purge } = stubPurge();
    const job = new RetentionJob({
      writer: {} as BatchedWriter,
      retentionDays: 30,
      now: () => now,
      purge,
    });
    job.start();
    expect(job.scheduled).toBe(true);
    await vi.advanceTimersByTimeAsync(PURGE_INITIAL_DELAY_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cutoff).toBe(NOW - 30 * DAY_MS);
    expect(calls[0]!.chunkRows).toBe(500);

    now += PURGE_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL_MS - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.cutoff).toBe(now - 30 * DAY_MS);
    expect(job.scheduled).toBe(true);
    await job.stop();
  });

  it('never keeps the process alive: its timer is unref’d', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const job = new RetentionJob({ writer: {} as BatchedWriter, retentionDays: 180 });
    job.start();
    const timer = spy.mock.results.at(-1)?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await job.stop();
  });

  it('does nothing with retention 0', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { calls, purge } = stubPurge();
    const job = new RetentionJob({ writer: {} as BatchedWriter, retentionDays: 0, purge });
    expect(job.enabled).toBe(false);
    job.start();
    expect(job.scheduled).toBe(false);
    await vi.advanceTimersByTimeAsync(7 * DAY_MS);
    await job.run();
    expect(calls).toHaveLength(0);
  });

  it('stops at shutdown: no timer, no reschedule, and a running purge ends after its chunk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Stopped before the first run: nothing ever runs.
    const idle = stubPurge();
    const before = new RetentionJob({
      writer: {} as BatchedWriter,
      retentionDays: 180,
      purge: idle.purge,
    });
    before.start();
    await before.stop();
    expect(before.scheduled).toBe(false);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(idle.calls).toHaveLength(0);

    // Stopped during a run (shutdown while purging): no next run is scheduled.
    const during = stubPurge();
    const job: RetentionJob = new RetentionJob({
      writer: {} as BatchedWriter,
      retentionDays: 180,
      purge: async (options) => {
        void job.stop();
        expect(options.stopped?.()).toBe(true);
        return during.purge(options);
      },
    });
    job.start();
    await vi.advanceTimersByTimeAsync(PURGE_INITIAL_DELAY_MS);
    expect(during.calls).toHaveLength(1);
    expect(job.scheduled).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * PURGE_INTERVAL_MS);
    expect(during.calls).toHaveLength(1);
    vi.useRealTimers();

    // The real purge, stopped right after it queued its first chunk.
    const { sqlite, writer } = await seeded();
    const real = new RetentionJob({ writer, retentionDays: 180, now: () => NOW, chunkRows: 100 });
    const run = real.run();
    const stopped = real.stop();
    await run;
    await stopped;
    expect(count(sqlite, 'audit_events', older)).toBe(OLD_AUDIT - 100);
    expect(count(sqlite, 'session_events', older)).toBe(OLD_SESSION);
    await real.run();
    expect(count(sqlite, 'audit_events', older)).toBe(OLD_AUDIT - 100);
  });

  it('logs the counts per table and the cutoff, never row contents', async () => {
    const { writer } = await seeded();
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const job = new RetentionJob({
      writer,
      retentionDays: 180,
      now: () => NOW,
      logger: pino({ level: 'info' }, sink),
    });
    await job.run();
    expect(lines.join('')).not.toContain(SECRET_MARKER);
    const finished = lines.map((l) => JSON.parse(l)).find((l) => l.msg?.includes('purge'));
    expect(finished).toMatchObject({
      msg: 'event retention purge finished',
      component: 'retention',
      retentionDays: 180,
      cutoff: new Date(CUTOFF).toISOString(),
      deleted: { audit_events: OLD_AUDIT, session_events: OLD_SESSION },
      complete: true,
    });
  });
});

describe('TERMDOCK_EVENT_RETENTION_DAYS', () => {
  const env = {
    TERMDOCK_PUBLIC_URL: 'https://termdock.test',
    TERMDOCK_WS_SECRET_FILE: '/run/secrets/ws_secret',
    TERMDOCK_MASTER_KEY_FILE: '/run/secrets/master_key',
    TERMDOCK_INTERNAL_TOKEN_FILE: '/run/secrets/internal_token',
  };
  const days = (value: string | undefined) =>
    loadDaemonConfig({ ...env, TERMDOCK_EVENT_RETENTION_DAYS: value }).eventRetentionDays;

  it('defaults to 180 days when unset or empty', () => {
    expect(DEFAULT_EVENT_RETENTION_DAYS).toBe(180);
    expect(loadDaemonConfig(env).eventRetentionDays).toBe(180);
    expect(days('')).toBe(180);
    expect(days('  ')).toBe(180);
  });

  it('accepts 0 (keep forever) and whole days from 7 to 3650', () => {
    expect(days('0')).toBe(0);
    expect(days('7')).toBe(7);
    expect(days(' 90 ')).toBe(90);
    expect(days('3650')).toBe(3650);
  });

  it('rejects anything else at boot, naming the variable', () => {
    for (const bad of ['6', '1', '3651', '-1', '1.5', '30d', 'abc', '1e3', '+30', '0x10']) {
      expect(() => days(bad), bad).toThrow(
        /invalid configuration: .*TERMDOCK_EVENT_RETENTION_DAYS: use 0 \(keep forever\)/,
      );
    }
  });
});
