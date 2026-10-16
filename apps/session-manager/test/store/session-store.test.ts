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
    store.appendEvent(b.id, { type: 'state_changed', detail: { to: 'failed' } });
    await writer.flush();

    expect((await store.get(a.id))?.policies.autoReopen).toBe(false);
    expect((await store.listRestorable()).map((r) => r.id)).toEqual([a.id]);
    const listed = await store.listForUser(userId);
    expect(listed.map((s) => [s.id, s.hostName, s.profileId])).toEqual([
      [b.id, 'box', profileId],
      [a.id, 'box', profileId],
    ]);

    // Profile deleted: history survives (profile_id NULL) and safe defaults apply.
    db.$client.prepare('DELETE FROM connection_profiles WHERE id = ?').run(profileId);
    const orphan = await store.get(a.id);
    expect(orphan?.policies).toEqual(DEFAULT_POLICIES);
    expect(orphan?.lastReadyAt).toBe(5);
  });
});
