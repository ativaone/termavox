import { describe, expect, it } from 'vitest';
import { createDriverFactory } from '../../src/core/driver-factory.ts';
import { SessionRegistry } from '../../src/core/session-registry.ts';
import {
  encode,
  FakeAttachment,
  FakeTransportFactory,
  MemoryHostKeyStore,
  MemorySessionStore,
  makeRecord,
  RecordingNotifier,
  until,
} from './fakes.ts';

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
