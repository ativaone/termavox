// T0: a session rename through the real daemon wiring (SQLite stores, internal API, registry,
// WebSocket server) booted in-process. No sshd: the target policy refuses the test host
// (127.0.0.1) before any connection, so the session parks in `failed`; a rename works in every
// state.
import type { ServerMessage } from '@termavox/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Daemon } from '../../src/main.ts';
import { until } from '../runtime/fakes.ts';
import { insertAuthSession, insertServer, insertUser } from '../store/fixture.ts';
import { DaemonFixture, VIEWPORT } from './harness.ts';

type Upsert = Extract<ServerMessage, { type: 'session.upsert' }>;
type List = Extract<ServerMessage, { type: 'sessions.list' }>;

let fixture: DaemonFixture;
let daemon: Daemon;

beforeAll(async () => {
  fixture = new DaemonFixture();
  fixture.config.sshAllowLocalTargets = false;
  daemon = await fixture.boot();
});

afterAll(async () => {
  await fixture?.cleanup();
});

describe('session rename through the daemon wiring (D-28)', () => {
  it('updates the runtime record and every connection of the owner live, nobody else', async () => {
    const { db } = daemon;
    const owner = insertUser(db);
    const other = insertUser(db);
    const serverId = insertServer(db, owner, { name: 'web box' });
    const created = await fixture.api(daemon, 'POST', '/sessions', {
      actingUserId: owner,
      serverId,
      label: '‮web​ ',
      viewport: VIEWPORT,
    });
    expect(created.status).toBe(201);
    const sessionId = created.json?.sessionId as string;
    const runtime = () => daemon.plane.registry.host(sessionId);
    await until(() => runtime()?.state === 'failed', 5_000);
    expect(runtime()?.label).toBe('web');

    const connect = (userId: string) =>
      fixture.connect(daemon, userId, insertAuthSession(db, userId, Date.now() + 3_600_000));
    const first = await connect(owner);
    const second = await connect(owner);
    const stranger = await connect(other);

    const renamed = await fixture.api(daemon, 'PATCH', `/sessions/${sessionId}`, {
      actingUserId: owner,
      label: ' deploy⁦ watcher ',
    });
    expect(renamed).toEqual({ status: 200, json: { sessionId, label: 'deploy watcher' } });
    // Both open connections get it on the socket they already had: no reconnect, no reload.
    for (const client of [first, second]) {
      const upsert = await client.next(
        (m): m is Upsert =>
          m.type === 'session.upsert' &&
          m.session.id === sessionId &&
          m.session.label === 'deploy watcher',
      );
      expect(upsert.session).toMatchObject({
        state: 'failed',
        serverId,
        serverName: 'web box',
        kind: 'ssh',
        hostname: '127.0.0.1',
        port: 22,
        username: 'tv',
      });
    }
    expect(runtime()?.label).toBe('deploy watcher');
    expect(stranger.messages.some((m) => m.type === 'session.upsert')).toBe(false);
    // A refused rename changes nothing anywhere.
    expect(
      (
        await fixture.api(daemon, 'PATCH', `/sessions/${sessionId}`, {
          actingUserId: other,
          label: 'x',
        })
      ).status,
    ).toBe(404);
    expect(runtime()?.label).toBe('deploy watcher');

    // A connection opened later lists the new name.
    const later = await connect(owner);
    const list = await later.next((m): m is List => m.type === 'sessions.list');
    expect(list.sessions.find((s) => s.id === sessionId)?.label).toBe('deploy watcher');
  });
});
