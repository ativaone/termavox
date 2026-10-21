import { SessionSummary } from '@termavox/protocol';
import { ErrorCode, TermavoxError } from '@termavox/shared';
import { describe, expect, it } from 'vitest';
import { createDriverFactory } from '../../src/core/driver-factory.ts';
import { SessionRegistry } from '../../src/core/session-registry.ts';
import {
  encode,
  FakeAttachment,
  type FakeTransportBehavior,
  FakeTransportFactory,
  MemoryHostKeyStore,
  MemorySessionStore,
  makeRecord,
  RecordingNotifier,
  until,
} from './fakes.ts';

function registryWith(behavior?: (attempt: number) => FakeTransportBehavior) {
  const store = new MemorySessionStore();
  const notifier = new RecordingNotifier();
  const factory = new FakeTransportFactory(behavior);
  const registry = new SessionRegistry({
    store,
    hostKeys: new MemoryHostKeyStore(),
    transports: factory,
    drivers: createDriverFactory(),
    notifier,
    installationId: 'install-1',
    runtime: { resizeDebounceMs: 1 },
  });
  return { store, notifier, factory, registry };
}

describe('SessionRegistry session.upsert', () => {
  it('publishes summary changes live: protection, first ready, end and reopen', async () => {
    const { store, notifier, factory, registry } = registryWith();
    const upserts = (): SessionSummary[] => notifier.ofType('session.upsert').map((m) => m.session);
    registry.create(store.add(makeRecord({ id: 's1' })));
    const rt = registry.host('s1')!;
    await until(() => rt.state === 'ready' && upserts().some((s) => s.lastReadyAt !== null));
    expect(upserts()[0]).toMatchObject({ id: 's1', protection: null }); // on creation
    expect(upserts().some((s) => s.protection === 'none')).toBe(true); // probe decided

    factory.last.pty.finish({ code: 0, signal: null });
    await until(() => upserts().some((s) => s.status === 'ended'));
    expect(upserts().at(-1)).toMatchObject({
      status: 'ended',
      endReason: 'shell_exited',
      endedAt: expect.any(Number),
      statusDetail: 'shell_exited',
    });

    const before = upserts().length;
    await registry.reopen('s1', 'user-1');
    await until(() => registry.host('s1')?.state === 'ready');
    await until(() =>
      upserts()
        .slice(before)
        .some((s) => s.protection === 'none'),
    );
    expect(upserts()[before]).toMatchObject({ endedAt: null, endReason: null });
    await registry.shutdown();
  });

  it('publishes a complete summary, kind included, for a session the store does not list', async () => {
    const { notifier, registry } = registryWith();
    // Not in the store: the upsert falls back to the record the runtime was spawned from.
    registry.create(
      makeRecord({
        id: 'unlisted',
        target: { kind: 'local', hostname: 'localhost', port: 0, username: '', credentialId: null },
      }),
    );
    await until(() => notifier.ofType('session.upsert').length > 0);
    const [upsert] = notifier.ofType('session.upsert');
    expect(SessionSummary.parse(upsert!.session)).toMatchObject({
      id: 'unlisted',
      serverId: 'server-1',
      serverName: 'localhost', // the record has no server name: the snapshotted hostname
      kind: 'local',
      hostname: 'localhost',
      port: 0,
      username: '',
    });
    await registry.shutdown();
  });

  it("keeps a failed session's reason in the list (statusDetail), also after a restart", async () => {
    const { store, registry } = registryWith(() => ({
      connect: async () => {
        throw new TermavoxError(ErrorCode.AuthRejected, 'nope');
      },
    }));
    const detailOf = async (id: string) =>
      (await registry.listForUser('user-1')).find((s) => s.id === id)?.statusDetail;
    // After a daemon restart only the row and its history are left.
    store.add(makeRecord({ id: 'old', state: 'failed', status: 'disconnected', lastReadyAt: 1 }));
    store.appendEvent('old', {
      type: 'state_changed',
      detail: { from: 'authenticating', to: 'failed', detail: 'HOST_KEY_REJECTED' },
    });
    expect(await detailOf('old')).toBe('HOST_KEY_REJECTED');
    await registry.attachable('old'); // a pane attaches: the runtime loads without a transition
    expect(await detailOf('old')).toBe('HOST_KEY_REJECTED');

    registry.create(store.add(makeRecord({ id: 'new' })));
    await until(() => registry.host('new')?.state === 'failed');
    expect(await detailOf('new')).toBe('AUTH_REJECTED');
    await registry.shutdown();
  });

  it('an expired sign-in prompt is not replayed to a later connection; the list says it expired', async () => {
    const store = new MemorySessionStore();
    const notifier = new RecordingNotifier();
    const registry = new SessionRegistry({
      store,
      hostKeys: new MemoryHostKeyStore(),
      transports: new FakeTransportFactory(() => ({
        connect: async (hooks) => {
          const answers = await hooks.onKeyboardInteractive({
            name: '',
            instructions: '',
            prompts: [{ text: 'OTP: ', echo: false }],
          });
          if (!answers) throw new TermavoxError(ErrorCode.AuthTimeout, 'expired');
        },
      })),
      drivers: createDriverFactory(),
      notifier,
      installationId: 'install-1',
      runtime: { resizeDebounceMs: 1, promptTimeoutMs: 40 },
    });
    registry.create(store.add(makeRecord({ id: 's1' })));
    // What a WebSocket that opens now gets after `sessions.list` (ws/server.ts).
    await until(() => registry.pendingPrompts('user-1').some((m) => m.type === 'auth.prompt'));
    await until(() =>
      notifier.ofType('session.status').some((m) => m.detail === ErrorCode.AuthTimeout),
    );
    expect(registry.pendingPrompts('user-1')).toEqual([]);
    const summary = (await registry.listForUser('user-1')).find((s) => s.id === 's1');
    expect(summary).toMatchObject({
      state: 'awaiting_user_input',
      status: 'action_required',
      statusDetail: ErrorCode.AuthTimeout,
    });
    await registry.shutdown();
  });
});

describe('SessionRegistry.reopen', () => {
  it('refuses protected live sessions; an ended one restarts with its attachments and seq', async () => {
    const store = new MemorySessionStore();
    const factory = new FakeTransportFactory();
    const registry = new SessionRegistry({
      store,
      hostKeys: new MemoryHostKeyStore(),
      transports: factory,
      drivers: createDriverFactory(),
      notifier: new RecordingNotifier(),
      installationId: 'install-1',
      runtime: { resizeDebounceMs: 1 },
    });
    store.add(makeRecord({ id: 'protected', protection: 'tmux-control', state: 'ready' }));
    await expect(registry.reopen('protected', 'user-1')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(registry.reopen('protected', 'someone-else')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const record = store.add(makeRecord({ id: 's1' }));
    registry.create(record);
    const first = registry.host('s1')!;
    await until(() => first.state === 'ready');
    const a = new FakeAttachment('a');
    first.attach(a, { cols: 80, rows: 24 });
    factory.last.pty.stdout.push(encode('hello\r\n'));
    await until(() => a.client.outputSeqs.length === 1);
    factory.last.pty.finish({ code: 0, signal: null });
    await until(() => first.state === 'ended');
    const lastSeq = first.seq;

    await registry.reopen('s1', 'user-1');
    const second = registry.host('s1')!;
    expect(second).not.toBe(first);
    await until(() => second.state === 'ready');
    expect(store.records.get('s1')).toMatchObject({ desiredState: 'running', endReason: null });
    // The attachment moved over: a fresh snapshot first, then seq continues (§5.4).
    await until(() => a.client.snapshots.length === 2);
    expect(a.client.snapshots[1]!.seq).toBe(lastSeq);
    factory.last.pty.stdout.push(encode('again\r\n'));
    await until(() => a.client.lastSeq === lastSeq + 1);
    expect(a.client.violations).toEqual([]);
    await registry.shutdown();
  });

  it('forgets the remote identity, so the new shell never reads as a remote reboot', async () => {
    const { store, registry } = registryWith();
    store.add(
      makeRecord({
        id: 's1',
        state: 'ended',
        desiredState: 'terminated',
        protection: 'tmux-control',
        remoteIdentity: { sessionCreated: 1, panePid: 42 },
      }),
    );
    await registry.reopen('s1', 'user-1');
    expect(store.records.get('s1')?.remoteIdentity).toBeNull();
    await registry.shutdown();
  });
});

describe('SessionRegistry.reopen and the running-session cap', () => {
  it("refuses past the cap with create's code and message, leaving the session as it was", async () => {
    const { store, factory, registry } = registryWith();
    store.runningCap = 1;
    registry.create(store.add(makeRecord({ id: 's1' })));
    const first = registry.host('s1')!;
    await until(() => first.state === 'ready');
    // An unprotected running session is not counted against its own reopen.
    expect(first.protection).toBe('none');
    await registry.reopen('s1', 'user-1');
    const second = registry.host('s1')!;
    await until(() => second.state === 'ready');
    factory.last.pty.finish({ code: 0, signal: null });
    await until(() => second.state === 'ended');

    // Another session of the same user now runs: the user is at the cap.
    store.add(makeRecord({ id: 's2' }));
    const reopens = () => store.events.filter((e) => e.type === 'reopened').length;
    const before = reopens();
    const error = await registry.reopen('s1', 'user-1').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TermavoxError);
    expect(error).toMatchObject({
      code: ErrorCode.RateLimited,
      message: 'running session limit reached (1)',
    });
    expect(registry.host('s1')).toBe(second);
    expect(second.state).toBe('ended');
    expect(reopens()).toBe(before);

    // Another user's sessions do not count; once the other one stops, the reopen goes through.
    store.add(makeRecord({ id: 'other', userId: 'user-2' }));
    store.update('s2', { desiredState: 'terminated' });
    await registry.reopen('s1', 'user-1');
    await until(() => registry.host('s1')?.state === 'ready');
    expect(reopens()).toBe(before + 1);
    await registry.shutdown();
  });
});

describe('SessionRegistry: a session whose server was deleted (D-29)', () => {
  it('refuses Reopen and Retry with NOT_FOUND, and boot restore only parks it', async () => {
    const { store, factory, registry } = registryWith();
    const refusal = { code: ErrorCode.NotFound, message: 'server was deleted' };
    const typesOf = (id: string) =>
      store.events.filter((e) => e.sessionId === id).map((e) => e.type);

    // Ended before its server was deleted: Reopen is refused and nothing changes.
    store.add(
      makeRecord({
        id: 'ended',
        serverId: null,
        state: 'ended',
        status: 'ended',
        desiredState: 'terminated',
        endedAt: 1,
        endReason: 'user_terminated',
      }),
    );
    await expect(registry.reopen('ended', 'user-1')).rejects.toMatchObject(refusal);
    await expect(registry.retry('ended', 'user-1')).rejects.toMatchObject(refusal);
    expect(store.records.get('ended')).toMatchObject({
      state: 'ended',
      desiredState: 'terminated',
    });
    expect(typesOf('ended')).toEqual([]);

    // Parked as failed: Retry is refused before the runtime tries anything.
    store.add(
      makeRecord({ id: 'failed', serverId: null, state: 'failed', status: 'disconnected' }),
    );
    await expect(registry.retry('failed', 'user-1')).rejects.toMatchObject(refusal);
    expect(typesOf('failed')).toEqual([]);

    // Meant to run when the daemon stopped: restore starts it, the runtime parks it at once.
    store.add(
      makeRecord({
        id: 'running',
        serverId: null,
        state: 'reconnecting',
        status: 'reconnecting',
        lastReadyAt: 1,
      }),
    );
    await registry.restore();
    expect(registry.host('running')?.state).toBe('failed');
    expect(registry.host('running')?.live().statusDetail).toBe('NOT_FOUND');
    expect(typesOf('running')).toEqual([
      'restore_started',
      'server_deleted',
      'state_changed',
      'restore_failed',
    ]);
    expect(factory.created).toHaveLength(0);
    // Failed sessions are not restorable: the next boot leaves it alone.
    expect((await store.listRestorable()).map((r) => r.id)).toEqual([]);
    await registry.shutdown();
  });
});

describe('SessionRegistry.stop (plan D-31)', () => {
  it('stops a retrying session of its owner; CONFLICT when it is not retrying, NOT_FOUND for others', async () => {
    const { store, registry } = registryWith(() => ({
      connect: async () => {
        throw new TermavoxError(ErrorCode.HostUnreachable, 'down');
      },
    }));
    registry.create(store.add(makeRecord({ id: 's1' })));
    const rt = registry.host('s1')!;
    await until(() => rt.state === 'reconnecting');
    await expect(registry.stop('s1', 'user-2')).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    await registry.stop('s1', 'user-1');
    expect(rt.live()).toMatchObject({ state: 'failed', statusDetail: 'RETRIES_STOPPED' });
    await expect(registry.stop('s1', 'user-1')).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });
    await registry.shutdown();
  });
});

describe('SessionRegistry.remove (plan D-32)', () => {
  it('removes an ended session and its runtime; refuses a live one; tells the owner', async () => {
    const { store, notifier, factory, registry } = registryWith();
    registry.create(store.add(makeRecord({ id: 's1' })));
    registry.create(store.add(makeRecord({ id: 's2' })));
    await until(
      () => registry.host('s1')?.state === 'ready' && registry.host('s2')?.state === 'ready',
    );
    await expect(registry.remove('s1', 'user-1')).rejects.toMatchObject({
      code: ErrorCode.Conflict,
    });

    factory.created[0]!.pty.finish({ code: 0, signal: null });
    await until(() => registry.host('s1')?.state === 'ended');
    await expect(registry.remove('s1', 'user-2')).rejects.toMatchObject({
      code: ErrorCode.NotFound,
    });
    await registry.remove('s1', 'user-1');
    expect(registry.host('s1')).toBeUndefined();
    expect(store.records.has('s1')).toBe(false);
    expect(notifier.ofType('session.removed')).toEqual([
      { type: 'session.removed', sessionId: 's1' },
    ]);

    await registry.terminate('s2', 'user-1');
    expect(await registry.removeEnded('user-1')).toBe(1);
    expect(registry.host('s2')).toBeUndefined();
    expect(notifier.ofType('session.removed').map((m) => m.sessionId)).toEqual(['s1', 's2']);
    await registry.shutdown();
  });
});
