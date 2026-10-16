import { afterEach, describe, expect, it } from 'vitest';
import { BatchedWriter } from '../../src/store/batched-writer.ts';
import { DEFAULT_POLICIES, SqliteSessionStore } from '../../src/store/session-store.ts';
import { insertHost, insertProfile, insertUser, type TempDb, tempDb } from './fixture.ts';

let fixture: TempDb;
afterEach(() => fixture?.cleanup());

describe('SqliteSessionStore', () => {
  it('reads live profile policies, overlays queued writes and filters restorable sessions', async () => {
    fixture = tempDb();
    const { db } = fixture;
    const writer = new BatchedWriter(db);
    const store = new SqliteSessionStore(db, writer);
    const userId = insertUser(db);
    const hostId = insertHost(db, userId, { name: 'box' });
    const profileId = insertProfile(db, userId, hostId, null, { autoReopen: false });
    const create = () =>
      store.createFromProfile({
        actingUserId: userId,
        profileId,
        viewport: { cols: 100, rows: 30 },
        enableLocalShell: false,
      });
    const a = await create();
    const b = await create();
    expect(a.tmuxToken).toMatch(/^[a-z2-7]{12}$/);
    expect(a.target).toMatchObject({ hostId, username: 'td', credentialId: null });

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
    const listed = await store.listForUser(userId);
    // A failed session keeps its last failure code (after a restart nothing else knows it).
    expect(listed.map((s) => [s.id, s.hostName, s.profileId, s.statusDetail])).toEqual([
      [b.id, 'box', profileId, 'AUTH_REJECTED'],
      [a.id, 'box', profileId, null],
    ]);

    // Profile deleted: history survives (profile_id NULL) and safe defaults apply.
    db.$client.prepare('DELETE FROM connection_profiles WHERE id = ?').run(profileId);
    const orphan = await store.get(a.id);
    expect(orphan?.policies).toEqual(DEFAULT_POLICIES);
    expect(orphan?.lastReadyAt).toBe(5);
  });

  it('applies the running-session cap to create and reopen alike, never counting the reopened row', async () => {
    fixture = tempDb();
    const { db } = fixture;
    const writer = new BatchedWriter(db);
    const store = new SqliteSessionStore(db, writer);
    const userId = insertUser(db);
    const profileId = insertProfile(db, userId, insertHost(db, userId), null);
    db.$client
      .prepare(
        "INSERT INTO instance_settings (key, value_json, updated_at) VALUES ('max_running_sessions_per_user', '1', 0)",
      )
      .run();
    const create = () =>
      store.createFromProfile({
        actingUserId: userId,
        profileId,
        viewport: { cols: 80, rows: 24 },
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
        `INSERT INTO sessions (id, user_id, profile_id, target_kind, target_host_id, target_hostname,
           target_port, target_username, term, scrollback_lines, label, desired_state, state, status,
           tmux_token, cols, rows, created_at)
         SELECT ?, user_id, profile_id, target_kind, target_host_id, target_hostname, target_port,
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
