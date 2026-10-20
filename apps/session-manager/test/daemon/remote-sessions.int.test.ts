// T1: remote tmux leftovers through the real daemon (plan D-30) on a tmux image (TV_TMUX_IMAGES
// to override). (a) End while not connected reaches the server; (b) a stray tmux server is listed
// as `other` and ended, and another one is adopted with its screen; (c) an ended session's
// surviving tmux is ended by the next connect to that server (sweep). The daemon reaches sshd
// through a local TCP proxy that can drop connections and hold new ones.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { openDb } from '@termavox/db';
import { ListRemoteSessionsResponse } from '@termavox/protocol';
import { randomToken } from '@termavox/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmuxSocketName } from '../../src/core/driver-factory.ts';
import type { Daemon } from '../../src/main.ts';
import { until } from '../runtime/fakes.ts';
import { HOST_KEY, requireSshd, TEST_USER, USER_KEY } from '../ssh/sshd.ts';
import { insertAuthSession, insertServer, insertUser } from '../store/fixture.ts';
import {
  killServerQuietly,
  selectedImages,
  sleep,
  TcpProxy,
  type TmuxEnv,
  tmuxEnv,
  tmuxExec,
} from '../tmux/driver-harness.ts';
import { DaemonFixture, shows, VIEWPORT } from './harness.ts';

const IMAGES = selectedImages(['tmux-3.4']);

async function eventually(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

describe.each(IMAGES)('remote tmux leftovers through the daemon (%s)', (image) => {
  let fixture: DaemonFixture;
  let env: TmuxEnv;
  let proxy: TcpProxy;
  let daemon: Daemon;
  let userId: string;
  let serverId: string;
  let asid: string;
  /** Every tmux server a test made or found, killed at the end whatever happened. */
  const sockets: string[] = [];

  const alive = async (socket: string): Promise<boolean> =>
    (await tmuxExec(env, socket, 'has-session')).code === 0;
  const socketOf = (sessionId: string): string => {
    const row = daemon.db.$client
      .prepare('SELECT tmux_token FROM sessions WHERE id = ?')
      .get(sessionId) as { tmux_token: string };
    const socket = tmuxSocketName(daemon.installationId, row.tmux_token);
    sockets.push(socket);
    return socket;
  };
  const events = (sessionId: string): Array<{ type: string; detail: unknown }> =>
    (
      daemon.db.$client
        .prepare('SELECT type, detail_json FROM session_events WHERE session_id = ? ORDER BY rowid')
        .all(sessionId) as Array<{ type: string; detail_json: string | null }>
    ).map((e) => ({ type: e.type, detail: e.detail_json ? JSON.parse(e.detail_json) : null }));
  const api = (method: string, path: string, body: Record<string, unknown> = {}) =>
    fixture.api(daemon, method, path, { actingUserId: userId, ...body });
  const createSession = async (): Promise<string> => {
    const created = await api('POST', '/sessions', { serverId, viewport: VIEWPORT });
    expect(created.status).toBe(201);
    const sessionId = created.json?.sessionId as string;
    await until(() => daemon.plane.registry.host(sessionId)?.state === 'ready', 20_000);
    expect(daemon.plane.registry.host(sessionId)?.protection).toBe('tmux-control');
    return sessionId;
  };
  const list = async () => {
    const listed = await api('POST', `/servers/${serverId}/remote-sessions`);
    expect(listed.status).toBe(200);
    return ListRemoteSessionsResponse.parse(listed.json);
  };

  beforeAll(async () => {
    await requireSshd([image]);
    env = await tmuxEnv(image);
    proxy = await TcpProxy.start(image);
    fixture = new DaemonFixture();
    daemon = await fixture.boot();
    userId = insertUser(daemon.db);
    const { credentialId } = await daemon.credentials.create({
      actingUserId: userId,
      kind: 'private_key',
      name: 'test key',
      privateKey: USER_KEY,
    });
    serverId = insertServer(daemon.db, userId, {
      name: image,
      port: proxy.port,
      username: TEST_USER,
      credentialId,
    });
    const trusted = await api('POST', `/servers/${serverId}/trust-key`, {
      keyType: HOST_KEY.type,
      fingerprint: HOST_KEY.fingerprint,
    });
    expect(trusted.status).toBe(204);
    asid = insertAuthSession(daemon.db, userId, Date.now() + 3_600_000);
  });

  afterAll(async () => {
    proxy?.release();
    await fixture?.cleanup();
    if (env) for (const socket of sockets) await killServerQuietly(env, socket);
    await proxy?.close();
    await env?.transport.close();
  });

  it('(a) End while not connected: a connection of its own ends the remote tmux', async () => {
    const sessionId = await createSession();
    const socket = socketOf(sessionId);
    expect(await alive(socket)).toBe(true);
    const runtime = daemon.plane.registry.host(sessionId)!;
    try {
      // The connection drops and the reconnect stalls at the proxy: no driver, nothing live.
      proxy.hold();
      proxy.dropAll();
      await until(() => runtime.state === 'connecting' && proxy.heldCount > 0, 15_000);
      const ending = api('POST', `/sessions/${sessionId}/terminate`);
      await until(() => runtime.state === 'terminating', 5_000);
      proxy.release(); // the cleanup's own connection goes through
      expect((await ending).status).toBe(204);
    } finally {
      proxy.release();
    }
    await until(() => runtime.state === 'ended', 20_000);
    expect(await alive(socket)).toBe(false);
    await daemon.writer.flush();
    const types = events(sessionId).map((e) => e.type);
    expect(types).toContain('remote_cleanup');
    expect(types).not.toContain('remote_cleanup_failed');
    expect(
      daemon.db.$client
        .prepare('SELECT state, desired_state, end_reason FROM sessions WHERE id = ?')
        .get(sessionId),
    ).toEqual({ state: 'ended', desired_state: 'terminated', end_reason: 'user_terminated' });
  });

  it('(b) a stray tmux server is listed as other and ended; another is adopted with its screen', async () => {
    const strayA = `tv-zzzzzzzz-${randomToken(12)}`;
    const strayB = `tv-zzzzzzzz-${randomToken(12)}`;
    sockets.push(strayA, strayB);
    for (const stray of [strayA, strayB]) {
      expect((await tmuxExec(env, stray, 'new-session -d -s main')).code).toBe(0);
    }
    expect(
      (await tmuxExec(env, strayB, "send-keys -t main 'echo STRAY-$((6*7))-MARK' Enter")).code,
    ).toBe(0);
    await eventually(
      async () =>
        (await tmuxExec(env, strayB, 'capture-pane -p -t main')).stdout.includes('STRAY-42-MARK'),
      10_000,
      'the stray pane output',
    );

    const found = await list();
    expect(found.error).toBeNull();
    expect(found.sessions.find((s) => s.socket === strayA)).toMatchObject({
      origin: 'other',
      sessionId: null,
      label: null,
      attachedClients: 0,
      createdAt: expect.any(Number),
      lastActivityAt: expect.any(Number),
    });
    expect(found.sessions.find((s) => s.socket === strayB)?.origin).toBe('other');

    expect(
      await api('POST', `/servers/${serverId}/remote-sessions/terminate`, { socket: strayA }),
    ).toEqual({
      status: 200,
      json: { terminated: true },
    });
    expect(await alive(strayA)).toBe(false);
    expect(
      await api('POST', `/servers/${serverId}/remote-sessions/terminate`, { socket: strayA }),
    ).toEqual({
      status: 200,
      json: { terminated: false },
    });

    const adopted = await api('POST', `/servers/${serverId}/remote-sessions/adopt`, {
      socket: strayB,
    });
    expect(adopted.status).toBe(201);
    const sessionId = adopted.json?.sessionId as string;
    await until(() => daemon.plane.registry.host(sessionId)?.state === 'ready', 20_000);
    const client = await fixture.attach(daemon, userId, asid, sessionId);
    await shows(client, /STRAY-42-MARK/);
    await daemon.writer.flush();
    expect(events(sessionId).map((e) => e.type)).not.toContain('adopt_target_gone');

    // It runs in Termavox now: never listed, ended or adopted from the server page.
    expect((await list()).sessions.map((s) => s.socket)).not.toContain(strayB);
    expect(
      (await api('POST', `/servers/${serverId}/remote-sessions/terminate`, { socket: strayB }))
        .status,
    ).toBe(409);
    expect(
      (await api('POST', `/servers/${serverId}/remote-sessions/adopt`, { socket: strayB })).status,
    ).toBe(409);

    // Ending the adopted session ends the stray's tmux server.
    expect((await api('POST', `/sessions/${sessionId}/terminate`)).status).toBe(204);
    await until(() => daemon.plane.registry.host(sessionId)?.state === 'ended', 15_000);
    expect(await alive(strayB)).toBe(false);
  });

  it('(c) the next connect to the server ends the surviving tmux of an ended session (sweep)', async () => {
    const forgotten = await createSession();
    const socket = socketOf(forgotten);
    await daemon.shutdown(); // graceful: the tmux keeps running on the server (§5.8)
    expect(await alive(socket)).toBe(true);
    // Termavox now thinks it ended long ago (its End could not reach the server, or a reset).
    const offline = openDb(fixture.config.dbFile);
    offline.$client
      .prepare(
        `UPDATE sessions SET state = 'ended', status = 'ended', desired_state = 'terminated',
                ended_at = ?, end_reason = 'user_terminated' WHERE id = ?`,
      )
      .run(Date.now() - 120_000, forgotten);
    offline.$client.close();

    daemon = await fixture.boot(); // a new process: its sweep has not run yet
    await daemon.restored;
    expect(daemon.plane.registry.host(forgotten)).toBeUndefined(); // not restored
    expect(await alive(socket)).toBe(true);

    const next = await createSession();
    await eventually(async () => !(await alive(socket)), 20_000, 'the sweep to end the leftover');
    await daemon.writer.flush();
    expect(events(forgotten)).toContainEqual({
      type: 'remote_cleanup',
      detail: { source: 'sweep' },
    });
    // The session that swept is untouched.
    expect(daemon.plane.registry.host(next)?.state).toBe('ready');
    expect(await alive(socketOf(next))).toBe(true);
    expect((await api('POST', `/sessions/${next}/terminate`)).status).toBe(204);
    await until(() => daemon.plane.registry.host(next)?.state === 'ended', 15_000);
  });
});
