import { SessionSummary } from '@termdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import { DEFAULT_POLICIES, SqliteSessionStore } from '../../src/store/session-store.ts';
import { insertServer, insertUser, type TempDb, tempDb } from './fixture.ts';

let fixture: TempDb;
afterEach(() => fixture?.cleanup());

const VIEWPORT = { cols: 80, rows: 24 };

function setup() {
  fixture = tempDb();
  const { db } = fixture;
  const writer = new BatchedWriter(db);
  return { db, writer, store: new SqliteSessionStore(db, writer) };
}

describe('SqliteSessionStore', () => {
  it('reads live server policies, overlays queued writes and filters restorable sessions', async () => {
    const { db, writer, store } = setup();
    const userId = insertUser(db);
    const serverId = insertServer(db, userId, { name: 'box', port: 2222, autoReopen: false });
    const create = () =>
      store.createFromServer({
        actingUserId: userId,
        serverId,
        viewport: { cols: 100, rows: 30 },
        enableLocalShell: false,
      });
    const a = await create();
    const b = await create();
    expect(a.tmuxToken).toMatch(/^[a-z2-7]{12}$/);
    expect(a).toMatchObject({ serverId, label: 'box' });
    expect(a.target).toEqual({
      kind: 'ssh',
      hostname: '127.0.0.1',
      port: 2222,
      username: 'td',
      credentialId: null,
    });

    store.update(a.id, { state: 'ready', status: 'connected', lastReadyAt: 5 });
    store.update(a.id, { protection: 'none' });
    // Read-your-writes before the flush.
    expect(await store.get(a.id)).toMatchObject({ state: 'ready', protection: 'none' });
    store.update(b.id, { state: 'failed', status: 'disconnected' });
    store.appendEvent(b.id, {
      type: 'state_changed',
      detail: { to: 'failed', detail: 'AUTH_REJECTED' },
    });
    store.appendEvent(b.id, { type: 'state_changed', detail: { to: 'connecting' } });
    await writer.flush();

    expect((await store.get(a.id))?.policies.autoReopen).toBe(false);
    expect((await store.listRestorable()).map((r) => r.id)).toEqual([a.id]);
    const summary = (s: Awaited<ReturnType<typeof store.listForUser>>[number]) => [
      s.id,
      s.serverId,
      s.serverName,
      s.kind,
      s.hostname,
      s.port,
      s.username,
      s.statusDetail,
    ];
    // A failed session keeps its last failure code (after a restart nothing else knows it).
    expect((await store.listForUser(userId)).map(summary)).toEqual([
      [b.id, serverId, 'box', 'ssh', '127.0.0.1', 2222, 'td', 'AUTH_REJECTED'],
      [a.id, serverId, 'box', 'ssh', '127.0.0.1', 2222, 'td', null],
    ]);
    // Every listed summary is a valid `SessionSummary` of the protocol.
    for (const listed of await store.listForUser(userId)) SessionSummary.parse(listed);
    const created = db.$client
      .prepare("SELECT detail_json FROM session_events WHERE session_id = ? AND type = 'created'")
      .get(a.id) as { detail_json: string };
    expect(JSON.parse(created.detail_json)).toEqual({ serverId });

    // The server is renamed: listings follow; the snapshot does not.
    db.$client.prepare("UPDATE servers SET name = 'box-2', port = 2200 WHERE id = ?").run(serverId);
    expect((await store.listForUser(userId)).map(summary)[1]).toEqual([
      a.id,
      serverId,
      'box-2',
      'ssh',
      '127.0.0.1',
      2222,
      'td',
      null,
    ]);

    // Server deleted: history survives (server_id NULL), safe defaults apply, and the listing
    // names the snapshotted hostname instead.
    db.$client.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    const orphan = await store.get(a.id);
    expect(orphan?.policies).toEqual(DEFAULT_POLICIES);
    expect(orphan?.serverId).toBeNull();
    expect(orphan?.lastReadyAt).toBe(5);
    expect((await store.listForUser(userId)).map(summary)[1]).toEqual([
      a.id,
      null,
      '127.0.0.1',
      'ssh',
      '127.0.0.1',
      2222,
      'td',
      null,
    ]);
  });

  it("creates only from the acting user's server; local servers keep direct mode and admin-only", async () => {
    const { db, store } = setup();
    const userA = insertUser(db);
    const userB = insertUser(db);
    const admin = insertUser(db, { role: 'user,admin' });
    const create = (actingUserId: string, serverId: string, enableLocalShell = false) =>
      store
        .createFromServer({ actingUserId, serverId, viewport: VIEWPORT, enableLocalShell })
        .catch((err: unknown) => err);
    const sessions = () =>
      (db.$client.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;

    // Another user's server, or none at all: NOT_FOUND, nothing inserted.
    const serverB = insertServer(db, userB);
    expect(await create(userA, serverB)).toMatchObject({
      code: 'NOT_FOUND',
      message: 'server not found',
    });
    expect(await create(userA, 'missing')).toMatchObject({ code: 'NOT_FOUND' });

    // A credential the acting user does not own (a row edited behind web's back): NOT_FOUND.
    db.$client
      .prepare(
        `INSERT INTO credentials (id, user_id, name, kind, ciphertext, nonce, key_version, created_at)
         VALUES ('cred-b', ?, 'b', 'password', x'00', x'00', 1, 0)`,
      )
      .run(userB);
    const foreignCredential = insertServer(db, userA, { credentialId: 'cred-b' });
    expect(await create(userA, foreignCredential)).toMatchObject({
      code: 'NOT_FOUND',
      message: 'credential not found',
    });

    // Local servers: refused while direct mode is off, and for non-admins when it is on.
    const localA = insertServer(db, userA, { kind: 'local', name: 'this machine' });
    const localAdmin = insertServer(db, admin, { kind: 'local', name: 'this machine' });
    expect(await create(userA, localA)).toMatchObject({ code: 'LOCAL_SHELL_DISABLED' });
    expect(await create(admin, localAdmin)).toMatchObject({ code: 'LOCAL_SHELL_DISABLED' });
    expect(await create(userA, localA, true)).toMatchObject({ code: 'FORBIDDEN' });
    expect(sessions()).toBe(0);

    // An admin with direct mode on: the snapshot is 'localhost', port 0, no user, no credential.
    const local = await create(admin, localAdmin, true);
    expect(local).toMatchObject({
      serverId: localAdmin,
      label: 'this machine',
      target: { kind: 'local', hostname: 'localhost', port: 0, username: '', credentialId: null },
    });
    expect(sessions()).toBe(1);
    // Listed with its kind, so nobody has to infer "local" from port 0.
    const [listed] = await store.listForUser(admin);
    expect(SessionSummary.parse(listed)).toMatchObject({
      serverId: localAdmin,
      serverName: 'this machine',
      kind: 'local',
      hostname: 'localhost',
      port: 0,
      username: '',
    });
  });

  it('snapshots the normalized hostname, so the host-key lookup matches the stored address', async () => {
    const { db, store } = setup();
    const userId = insertUser(db);
    // Web stores it normalized; a row that is not still yields the one spelling (plan D-29).
    const serverId = insertServer(db, userId, { hostname: ' DB.Internal ', port: 2201 });
    const record = await store.createFromServer({
      actingUserId: userId,
      serverId,
      label: 'db',
      viewport: VIEWPORT,
      enableLocalShell: false,
    });
    expect(record.target).toMatchObject({ hostname: 'db.internal', port: 2201 });
    expect((await store.get(record.id))?.target.hostname).toBe('db.internal');
    expect((await store.listForUser(userId))[0]).toMatchObject({
      serverName: 'test server',
      kind: 'ssh',
      hostname: 'db.internal',
      port: 2201,
    });
  });

  it('applies the running-session cap to create and reopen alike, never counting the reopened row', async () => {
    const { db, store } = setup();
    const userId = insertUser(db);
    const serverId = insertServer(db, userId);
    db.$client
      .prepare(
        "INSERT INTO instance_settings (key, value_json, updated_at) VALUES ('max_running_sessions_per_user', '1', 0)",
      )
      .run();
    const create = () =>
      store.createFromServer({
        actingUserId: userId,
        serverId,
        viewport: VIEWPORT,
        enableLocalShell: false,
      });
    const running = await create();
    const createError = await create().catch((err: unknown) => err);
    expect(createError).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'running session limit reached (1)',
    });
    // The running one may be reopened (it is the one counted).
    await expect(store.assertRunningCapacity(userId, running.id)).resolves.toBeUndefined();

    // An ended session cannot come back while another one runs: same code, same message.
    const ended = { ...running, id: `${running.id.slice(0, -4)}beef` };
    db.$client
      .prepare(
        `INSERT INTO sessions (id, user_id, server_id, target_kind, target_hostname, target_port,
           target_username, term, scrollback_lines, label, desired_state, state, status,
           tmux_token, cols, rows, created_at)
         SELECT ?, user_id, server_id, target_kind, target_hostname, target_port,
           target_username, term, scrollback_lines, label, 'terminated', 'ended', 'ended',
           tmux_token, cols, rows, created_at FROM sessions WHERE id = ?`,
      )
      .run(ended.id, running.id);
    const reopenError = await store
      .assertRunningCapacity(userId, ended.id)
      .catch((err: unknown) => err);
    expect(reopenError).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'running session limit reached (1)',
    });
    // A terminate that is still queued counts as done (the check runs behind it).
    store.update(running.id, { desiredState: 'terminated' });
    await expect(store.assertRunningCapacity(userId, ended.id)).resolves.toBeUndefined();
  });
});
