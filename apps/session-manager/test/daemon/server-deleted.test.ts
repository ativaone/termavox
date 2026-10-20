// T0: a session whose server was deleted, through the real daemon wiring (SQLite stores,
// internal API, registry) booted in-process and restarted on the same DB. No sshd: the target
// policy refuses the test host (127.0.0.1) before any connection, so sessions park in `failed`
// (TARGET_NOT_ALLOWED) and the deleted server's refusal is told apart by its own code.
import { openDb } from '@termavox/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Daemon } from '../../src/main.ts';
import { until } from '../runtime/fakes.ts';
import { insertServer, insertUser } from '../store/fixture.ts';
import { DaemonFixture, VIEWPORT } from './harness.ts';

let fixture: DaemonFixture;

beforeAll(() => {
  fixture = new DaemonFixture();
  fixture.config.sshAllowLocalTargets = false;
});

afterAll(async () => {
  await fixture?.cleanup();
});

function events(daemon: Daemon, sessionId: string): Array<{ type: string; detail: unknown }> {
  return (
    daemon.db.$client
      .prepare('SELECT type, detail_json FROM session_events WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as Array<{ type: string; detail_json: string | null }>
  ).map((e) => ({ type: e.type, detail: e.detail_json ? JSON.parse(e.detail_json) : null }));
}

describe('a session whose server was deleted never connects again (D-29)', () => {
  it('Reopen and Retry answer 404 "server was deleted"; boot restore parks it as failed', async () => {
    const first = await fixture.boot();
    const { db } = first;
    const userId = insertUser(db);
    const create = async (serverId: string) => {
      const created = await fixture.api(first, 'POST', '/sessions', {
        actingUserId: userId,
        serverId,
        viewport: VIEWPORT,
      });
      expect(created.status).toBe(201);
      const sessionId = created.json?.sessionId as string;
      await until(() => first.plane.registry.host(sessionId)?.state === 'failed', 5_000);
      return sessionId;
    };
    const row = (daemon: Daemon, sessionId: string) =>
      daemon.db.$client
        .prepare('SELECT server_id, desired_state, state FROM sessions WHERE id = ?')
        .get(sessionId);

    // Web deletes a server only once its sessions ended: end the session, then delete it.
    const serverId = insertServer(db, userId, { name: 'retired' });
    const ended = await create(serverId);
    expect(
      (await fixture.api(first, 'POST', `/sessions/${ended}/terminate`, { actingUserId: userId }))
        .status,
    ).toBe(204);
    await until(() => first.plane.registry.host(ended)?.state === 'ended', 5_000);
    db.$client.prepare('DELETE FROM servers WHERE id = ?').run(serverId);

    const refusal = { code: 'NOT_FOUND', message: 'server was deleted' };
    for (const action of ['reopen', 'retry']) {
      expect(
        await fixture.api(first, 'POST', `/sessions/${ended}/${action}`, { actingUserId: userId }),
      ).toEqual({ status: 404, json: refusal });
    }
    await first.writer.flush();
    expect(row(first, ended)).toEqual({
      server_id: null,
      desired_state: 'terminated',
      state: 'ended',
    });
    expect(events(first, ended).map((e) => e.type)).not.toContain('reopened');

    // A session meant to run whose server disappears while the daemon is down (outside web).
    const doomed = insertServer(db, userId, { name: 'doomed' });
    const restorable = await create(doomed);
    await first.shutdown();
    const offline = openDb(fixture.config.dbFile);
    offline.$client
      .prepare("UPDATE sessions SET state = 'reconnecting', status = 'reconnecting' WHERE id = ?")
      .run(restorable);
    offline.$client.prepare('DELETE FROM servers WHERE id = ?').run(doomed);
    offline.$client.close();

    const second = await fixture.boot();
    await second.restored;
    const runtime = second.plane.registry.host(restorable);
    expect(runtime?.state).toBe('failed');
    expect(runtime?.live().statusDetail).toBe('NOT_FOUND');
    await second.writer.flush();
    const sinceRestore = () => {
      const all = events(second, restorable);
      return all.slice(all.findLastIndex((e) => e.type === 'restore_started'));
    };
    expect(sinceRestore()).toEqual([
      { type: 'restore_started', detail: null },
      { type: 'server_deleted', detail: null },
      {
        type: 'state_changed',
        detail: { from: 'reconnecting', to: 'failed', detail: 'NOT_FOUND' },
      },
      { type: 'restore_failed', detail: { state: 'failed' } },
    ]);
    expect(row(second, restorable)).toEqual({
      server_id: null,
      desired_state: 'running',
      state: 'failed',
    });
    // Parked, not retried: nothing more happens to it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await second.writer.flush();
    expect(sinceRestore()).toHaveLength(4);
    expect(
      await fixture.api(second, 'POST', `/sessions/${restorable}/retry`, { actingUserId: userId }),
    ).toEqual({ status: 404, json: refusal });
  });
});
