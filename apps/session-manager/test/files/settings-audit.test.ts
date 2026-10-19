import { afterEach, describe, expect, it } from 'vitest';
import { cachedFileSettings, DEFAULT_FILE_SETTINGS } from '../../src/files/settings.ts';
import { insertAudit } from '../../src/store/audit.ts';
import {
  readFileSettings,
  SETTING_FILE_AUDIT_ENABLED,
  SETTING_FILE_TRANSFER_ENABLED,
} from '../../src/store/settings.ts';
import { type TempDb, tempDb } from '../store/fixture.ts';

let temp: TempDb | null = null;
afterEach(() => {
  temp?.cleanup();
  temp = null;
});

function store(key: string, value: string): void {
  temp!.db.$client
    .prepare(
      `INSERT INTO instance_settings (key, value_json, updated_at) VALUES (?, ?, 0)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, value);
}

describe('file panel settings (web-owned)', () => {
  it('reads transfer as on unless stored false, the audit only when stored true', () => {
    temp = tempDb();
    const sqlite = temp.db.$client;
    expect(readFileSettings(sqlite)).toEqual({ transferEnabled: true, auditEnabled: false });
    store(SETTING_FILE_TRANSFER_ENABLED, 'false');
    store(SETTING_FILE_AUDIT_ENABLED, 'true');
    expect(readFileSettings(sqlite)).toEqual({ transferEnabled: false, auditEnabled: true });
    // Anything else (a string, garbage) keeps the defaults.
    store(SETTING_FILE_TRANSFER_ENABLED, '"false"');
    store(SETTING_FILE_AUDIT_ENABLED, '1');
    expect(readFileSettings(sqlite)).toEqual({ transferEnabled: true, auditEnabled: false });
    store(SETTING_FILE_TRANSFER_ENABLED, 'not json');
    expect(readFileSettings(sqlite).transferEnabled).toBe(true);
  });

  it('reads through a cache of a couple of seconds, keeping the last value on failure', () => {
    let now = 0;
    let loads = 0;
    let value = { transferEnabled: false, auditEnabled: true };
    let fail = false;
    const errors: unknown[] = [];
    const read = cachedFileSettings(
      () => {
        loads++;
        if (fail) throw new Error('database is locked');
        return value;
      },
      { ttlMs: 2_000, now: () => now, onError: (err) => errors.push(err) },
    );
    expect(read()).toEqual(value);
    value = { transferEnabled: true, auditEnabled: false };
    now = 1_999;
    expect(read().transferEnabled).toBe(false); // cached
    now = 2_000;
    expect(read().transferEnabled).toBe(true);
    expect(loads).toBe(2);
    fail = true;
    now = 5_000;
    expect(read()).toEqual(value);
    expect(errors).toHaveLength(1);

    const failingFirst = cachedFileSettings(() => {
      throw new Error('no table');
    });
    expect(failingFirst()).toEqual(DEFAULT_FILE_SETTINGS);
  });
});

describe('file audit rows', () => {
  it("records the client's address and user agent", () => {
    temp = tempDb();
    const sqlite = temp.db.$client;
    insertAudit(sqlite, {
      type: 'file.rename',
      actorUserId: null,
      targetType: 'session',
      targetId: 'session-1',
      detail: { serverId: 'server-1', from: '/a', to: '/b' },
      ip: '203.0.113.7',
      userAgent: 'test-agent/1.0',
      at: 1_234,
    });
    insertAudit(sqlite, {
      type: 'session.rename',
      actorUserId: null,
      targetType: 'session',
      targetId: 'session-2',
    });
    const rows = sqlite
      .prepare(
        'SELECT type, target_type, target_id, detail_json, ip, user_agent, created_at FROM audit_events ORDER BY rowid',
      )
      .all();
    expect(rows).toEqual([
      {
        type: 'file.rename',
        target_type: 'session',
        target_id: 'session-1',
        detail_json: '{"serverId":"server-1","from":"/a","to":"/b"}',
        ip: '203.0.113.7',
        user_agent: 'test-agent/1.0',
        created_at: 1_234,
      },
      expect.objectContaining({ type: 'session.rename', ip: null, user_agent: null }),
    ]);
  });
});
