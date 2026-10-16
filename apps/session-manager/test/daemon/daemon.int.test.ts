// T1: the real daemon wiring (SQLite stores, vault, internal API, WS) booted in-process against
// the no-tmux sshd, restarted on the same DB.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Daemon } from '../../src/main.ts';
import { until } from '../runtime/fakes.ts';
import { HOST_KEY, requireSshd, SSHD_PORTS, TEST_USER, USER_KEY } from '../ssh/sshd.ts';
import {
  auditTypes,
  insertAuthSession,
  insertHost,
  insertProfile,
  insertUser,
} from '../store/fixture.ts';
import { DaemonFixture, shows, VIEWPORT } from './harness.ts';

let fixture: DaemonFixture;

/** Session events of a session, oldest first. */
function events(daemon: Daemon, sessionId: string): Array<{ type: string; detail: unknown }> {
  return (
    daemon.db.$client
      .prepare('SELECT type, detail_json FROM session_events WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as Array<{ type: string; detail_json: string | null }>
  ).map((e) => ({ type: e.type, detail: e.detail_json ? JSON.parse(e.detail_json) : null }));
}

function sessionRow(daemon: Daemon, sessionId: string): Record<string, unknown> {
  return daemon.db.$client
    .prepare(
      'SELECT desired_state, state, protection_effective, last_ready_at, end_reason FROM sessions WHERE id = ?',
    )
    .get(sessionId) as Record<string, unknown>;
}

beforeAll(async () => {
  await requireSshd(['no-tmux']);
  fixture = new DaemonFixture();
});

afterAll(async () => {
  await fixture?.cleanup();
});

describe('daemon (SQLite + vault + internal API + WS) against no-tmux', () => {
  it('creates, attaches, survives a daemon restart as a new shell, and terminates', async () => {
    // ── first boot: seed through the stores, create over the internal API ──
    const first = await fixture.boot();
    const { db } = first;
    const userId = insertUser(db);
    const hostId = insertHost(db, userId, { name: 'no-tmux', port: SSHD_PORTS['no-tmux'] });
    const { credentialId } = await first.credentials.create({
      actingUserId: userId,
      kind: 'private_key',
      name: 'test key',
      privateKey: USER_KEY,
    });
    // "Fetch & verify": the unknown key is recorded as pending, then trusted by fingerprint.
    const fetched = await fixture.api(first, 'POST', `/hosts/${hostId}/test`, {
      actingUserId: userId,
    });
    expect(fetched).toEqual({
      status: 200,
      json: {
        reachable: true,
        error: null,
        hostKey: { type: HOST_KEY.type, fingerprint: HOST_KEY.fingerprint, trusted: false },
        probe: null,
      },
    });
    expect((await first.hostKeys.list(hostId)).map((k) => k.status)).toEqual(['pending']);
    const trustKey = { actingUserId: userId, keyType: HOST_KEY.type };
    expect(
      (
        await fixture.api(first, 'POST', `/hosts/${hostId}/trust-key`, {
          ...trustKey,
          fingerprint: HOST_KEY.fingerprint,
        })
      ).status,
    ).toBe(204);
    const profileId = insertProfile(db, userId, hostId, credentialId, {
      username: TEST_USER,
      autoReopen: true,
    });
    // With a profile and a trusted key the test authenticates and runs the capability probe.
    const probed = await fixture.api(first, 'POST', `/hosts/${hostId}/test`, {
      actingUserId: userId,
      profileId,
    });
    expect(probed.json).toMatchObject({
      reachable: true,
      error: null,
      hostKey: { trusted: true },
      probe: { shell: '/bin/bash' }, // no-tmux image: no tmux_path key
    });
    const asid = insertAuthSession(db, userId, Date.now() + 3_600_000);

    const create = (profile: string) =>
      fixture.api(first, 'POST', '/sessions', {
        actingUserId: userId,
        profileId: profile,
        viewport: VIEWPORT,
      });
    const created = await create(profileId);
    expect(created.status).toBe(201);
    const sessionId = created.json?.sessionId as string;
    // A second session whose profile does not reopen (checked after the restart).
    const noReopenProfile = insertProfile(db, userId, hostId, credentialId, {
      username: TEST_USER,
      autoReopen: false,
    });
    const noReopenId = (await create(noReopenProfile)).json?.sessionId as string;
    await until(
      () =>
        first.plane.registry.host(sessionId)?.state === 'ready' &&
        first.plane.registry.host(noReopenId)?.state === 'ready',
      15_000,
    );
    // Phase 3 F: no tmux on the host → protection none, with the notice.
    await first.writer.flush();
    expect(events(first, sessionId)).toContainEqual({
      type: 'protection_selected',
      detail: { protection: 'none', notice: 'tmux not found on the host: session not protected' },
    });

    const client = await fixture.attach(first, userId, asid, sessionId);
    await shows(client, /\$ ?$/m);
    client.input(1, 'echo first-$((40+2))\r');
    await shows(client, /^first-42$/m);
    await client.close();

    // ── restart on the same DB ──
    await first.shutdown();
    const second = await fixture.boot();
    const row = sessionRow(second, sessionId);
    expect(row).toMatchObject({
      desired_state: 'running',
      state: 'ready',
      protection_effective: 'none',
    });
    expect(row.last_ready_at).toEqual(expect.any(Number));
    await second.restored;
    await until(() => second.plane.registry.host(sessionId)?.state === 'ready', 15_000);

    // raw protection + auto_reopen: the screen was in RAM; a new shell starts after a banner.
    const again = await fixture.attach(second, userId, asid, sessionId);
    const restored = await shows(again, /Termdock restarted/);
    expect(restored).not.toContain('first-42');
    again.input(1, 'echo second-$((1+1))\r');
    await shows(again, /^second-2$/m);
    await second.writer.flush();
    expect(events(second, sessionId).map((e) => e.type)).toEqual(
      expect.arrayContaining(['created', 'restore_started', 'restored']),
    );
    // Phase 4 D: without auto_reopen the restart ends the session (service_restarted).
    expect(sessionRow(second, noReopenId)).toMatchObject({
      desired_state: 'terminated',
      state: 'ended',
      end_reason: 'service_restarted',
    });

    // ── terminate over the internal API ──
    const terminated = await fixture.api(second, 'POST', `/sessions/${sessionId}/terminate`, {
      actingUserId: userId,
    });
    expect(terminated.status).toBe(204);
    await again.next(
      (m) => m.type === 'session.status' && m.sessionId === sessionId && m.status === 'ended',
    );
    await second.writer.flush();
    expect(
      second.db.$client
        .prepare('SELECT desired_state, state, end_reason FROM sessions WHERE id = ?')
        .get(sessionId),
    ).toEqual({ desired_state: 'terminated', state: 'ended', end_reason: 'user_terminated' });
    await second.shutdown();
  });

  it('host keys over the protocol: prompt → decision → trusted; a mismatch has no in-flow accept; replace and revoke', async () => {
    const daemon = await fixture.boot();
    const { db } = daemon;
    const userId = insertUser(db);
    const hostName = 'rekeyed';
    const hostId = insertHost(db, userId, { name: hostName, port: SSHD_PORTS['no-tmux'] });
    const { credentialId } = await daemon.credentials.create({
      actingUserId: userId,
      kind: 'private_key',
      name: 'test key',
      privateKey: USER_KEY,
    });
    const profileId = insertProfile(db, userId, hostId, credentialId, { username: TEST_USER });
    const asid = insertAuthSession(db, userId, Date.now() + 3_600_000);
    const watcher = await fixture.connect(daemon, userId, asid);
    const create = async () =>
      (
        await fixture.api(daemon, 'POST', '/sessions', {
          actingUserId: userId,
          profileId,
          viewport: VIEWPORT,
        })
      ).json?.sessionId as string;
    const status = (sessionId: string, value: string) =>
      watcher.next(
        (m) => m.type === 'session.status' && m.sessionId === sessionId && m.status === value,
        15_000,
      );
    const keys = async () => {
      await daemon.writer.flush();
      return (await daemon.hostKeys.list(hostId)).map((k) => ({
        status: k.status,
        fingerprint: k.fingerprint,
        publicKeyB64: k.publicKeyB64,
      }));
    };
    const live = { fingerprint: HOST_KEY.fingerprint, publicKeyB64: HOST_KEY.publicKeyB64 };
    const otherFingerprint = `SHA256:${'Q'.repeat(43)}`;

    // Unknown key: a pending row, the connection aborted, a prompt with type and fingerprint.
    const sessionId = await create();
    expect(await watcher.next((m) => m.type === 'hostkey.prompt', 15_000)).toEqual({
      type: 'hostkey.prompt',
      sessionId,
      keyType: HOST_KEY.type,
      fingerprint: HOST_KEY.fingerprint,
      mismatch: false,
    });
    expect(daemon.plane.registry.host(sessionId)?.state).toBe('awaiting_host_key');
    expect(await keys()).toEqual([{ status: 'pending', ...live }]);
    // A decision for another fingerprint trusts nothing.
    watcher.send({
      type: 'hostkey.decision',
      sessionId,
      fingerprint: otherFingerprint,
      accept: true,
    });
    expect(await watcher.next((m) => m.type === 'error')).toMatchObject({
      code: 'CONFLICT',
      sessionId,
    });
    expect(await keys()).toEqual([{ status: 'pending', ...live }]);
    // Accept trusts exactly that key (audited) and the session reconnects to ready.
    watcher.send({
      type: 'hostkey.decision',
      sessionId,
      fingerprint: HOST_KEY.fingerprint,
      accept: true,
    });
    await status(sessionId, 'connected');
    expect(await keys()).toEqual([{ status: 'trusted', ...live }]);
    expect(auditTypes(db)).toEqual(expect.arrayContaining(['host_key.pending', 'host_key.trust']));

    // The trusted key no longer matches what the host presents (as after a host re-key).
    const replace = (fingerprint: string, confirmHostName = hostName) =>
      fixture.api(daemon, 'POST', `/hosts/${hostId}/replace-key`, {
        actingUserId: userId,
        keyType: HOST_KEY.type,
        fingerprint,
        confirmHostName,
      });
    expect((await replace(otherFingerprint, 'wrong name')).status).toBe(400);
    expect((await replace(otherFingerprint)).status).toBe(204);
    // The host still presents the key that replace just revoked: refused like any mismatch,
    // and flagged as a revoked key (§5.9).
    const mismatched = await create();
    expect(
      await watcher.next((m) => m.type === 'hostkey.prompt' && m.sessionId === mismatched, 15_000),
    ).toMatchObject({ fingerprint: HOST_KEY.fingerprint, mismatch: true, revoked: true });
    expect(await status(mismatched, 'disconnected')).toMatchObject({
      state: 'failed',
      detail: 'HOST_KEY_MISMATCH',
    });
    // No in-flow accept: the decision is refused and nothing changes.
    const before = watcher.messages.length;
    watcher.send({
      type: 'hostkey.decision',
      sessionId: mismatched,
      fingerprint: HOST_KEY.fingerprint,
      accept: true,
    });
    await watcher.next((m) => m.type === 'error' && watcher.messages.indexOf(m) >= before);
    expect(daemon.plane.registry.host(mismatched)?.state).toBe('failed');
    expect((await keys()).find((k) => k.status === 'trusted')?.fingerprint).toBe(otherFingerprint);
    expect(auditTypes(db)).toEqual(
      expect.arrayContaining(['host_key.replace', 'host_key.revoked_presented']),
    );

    // The owner replaces the key (typed host name) and retries: connected; the replaced key was
    // pasted, so its public key is learned from the handshake.
    expect((await replace(HOST_KEY.fingerprint)).status).toBe(204);
    expect(
      (await fixture.api(daemon, 'POST', `/sessions/${mismatched}/retry`, { actingUserId: userId }))
        .status,
    ).toBe(204);
    await status(mismatched, 'connected');
    expect((await keys()).find((k) => k.status === 'trusted')).toEqual({
      status: 'trusted',
      ...live,
    });

    // Revoke marks the trusted key revoked; a second revoke finds none.
    const revoke = () =>
      fixture.api(daemon, 'POST', `/hosts/${hostId}/revoke-key`, {
        actingUserId: userId,
        keyType: HOST_KEY.type,
      });
    expect((await revoke()).status).toBe(204);
    expect((await revoke()).status).toBe(404);
    expect((await keys()).filter((k) => k.status === 'trusted')).toEqual([]);

    // The revoked key presented again with nothing trusted: no first-use prompt, refused like a
    // mismatch; neither the prompt, trust-key nor pre-trust can bring it back (M2).
    const afterRevoke = await create();
    expect(
      await watcher.next((m) => m.type === 'hostkey.prompt' && m.sessionId === afterRevoke, 15_000),
    ).toMatchObject({ fingerprint: HOST_KEY.fingerprint, mismatch: true, revoked: true });
    expect(await status(afterRevoke, 'disconnected')).toMatchObject({
      state: 'failed',
      detail: 'HOST_KEY_MISMATCH',
    });
    expect((await keys()).filter((k) => k.status === 'pending')).toEqual([]);
    const trustAgain = await fixture.api(daemon, 'POST', `/hosts/${hostId}/trust-key`, {
      actingUserId: userId,
      keyType: HOST_KEY.type,
      fingerprint: HOST_KEY.fingerprint,
    });
    expect(trustAgain.status).toBe(409);
    expect((await keys()).filter((k) => k.status === 'trusted')).toEqual([]);
    for (const id of [sessionId, mismatched, afterRevoke]) {
      await fixture.api(daemon, 'POST', `/sessions/${id}/terminate`, { actingUserId: userId });
    }
  });
});
