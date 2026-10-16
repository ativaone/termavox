import type { SessionSummary } from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
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

  it("keeps a failed session's reason in the list (statusDetail), also after a restart", async () => {
    const { store, registry } = registryWith(() => ({
      connect: async () => {
        throw new TermdockError(ErrorCode.AuthRejected, 'nope');
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
});
