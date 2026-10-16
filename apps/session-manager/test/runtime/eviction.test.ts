import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDriverFactory } from '../../src/core/driver-factory.ts';
import { RUNTIME_IDLE_TTL_MS, SessionRegistry } from '../../src/core/session-registry.ts';
import type { SessionRuntime } from '../../src/core/session-runtime.ts';
import type { SessionRecord } from '../../src/core/types.ts';
import {
  FakeAttachment,
  FakeTransportFactory,
  MemoryHostKeyStore,
  MemorySessionStore,
  makeRecord,
  RecordingNotifier,
} from './fakes.ts';

const TTL = RUNTIME_IDLE_TTL_MS;
const VIEWPORT = { cols: 80, rows: 24 };

function setup() {
  const store = new MemorySessionStore();
  const registry = new SessionRegistry({
    store,
    hostKeys: new MemoryHostKeyStore(),
    transports: new FakeTransportFactory(),
    drivers: createDriverFactory(),
    notifier: new RecordingNotifier(),
    installationId: 'install-1',
    runtime: { resizeDebounceMs: 1, lagPollMs: 5 },
  });
  const load = async (id: string) => (await registry.attachable(id)) as SessionRuntime;
  return { store, registry, load };
}

function ended(id: string): SessionRecord {
  return makeRecord({
    id,
    state: 'ended',
    status: 'ended',
    desiredState: 'terminated',
    lastReadyAt: 1,
    endedAt: 2,
    endReason: 'shell_exited',
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('idle runtime eviction (M4)', () => {
  it('disposes an ended session 60 s after its last detach; a later attach loads a fresh one', async () => {
    const { store, registry, load } = setup();
    store.add(ended('s1'));
    const first = await load('s1');
    first.attach(new FakeAttachment('a'), VIEWPORT);
    await vi.advanceTimersByTimeAsync(3 * TTL);
    expect(registry.host('s1')).toBe(first); // watched: kept

    first.detach('a');
    await vi.advanceTimersByTimeAsync(TTL - 1);
    expect(registry.host('s1')).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(registry.host('s1')).toBeUndefined();
    // The disposed runtime is closed for good: nothing attaches to it any more.
    first.attach(new FakeAttachment('late'), VIEWPORT);
    expect(first.attachmentCount).toBe(0);

    const second = await load('s1');
    expect(second).not.toBe(first);
    const b = new FakeAttachment('b');
    second.attach(b, VIEWPORT);
    expect(second.attachmentCount).toBe(1);
    expect(b.frames.length).toBeGreaterThan(0); // session.attached from the fresh runtime
    await vi.waitFor(() => expect(b.client.snapshots).toHaveLength(1));
    await registry.shutdown();
  });

  it('an attach before the TTL keeps it, and the TTL restarts at the next detach', async () => {
    const { store, registry, load } = setup();
    store.add(ended('s2'));
    const runtime = await load('s2'); // loaded idle: the timer runs from here
    await vi.advanceTimersByTimeAsync(TTL - 10);
    runtime.attach(new FakeAttachment('a'), VIEWPORT);
    await vi.advanceTimersByTimeAsync(20);
    expect(registry.host('s2')).toBe(runtime);
    runtime.detach('a');
    await vi.advanceTimersByTimeAsync(TTL - 1);
    expect(registry.host('s2')).toBe(runtime);
    await vi.advanceTimersByTimeAsync(1);
    expect(registry.host('s2')).toBeUndefined();
    await registry.shutdown();
  });

  it('never evicts a session that should run, attached or not', async () => {
    const { store, registry, load } = setup();
    // Parked on a failure, waiting for Retry: desired state running.
    store.add(
      makeRecord({ id: 'parked', state: 'failed', status: 'disconnected', lastReadyAt: 1 }),
    );
    const parked = await load('parked');
    parked.attach(new FakeAttachment('a'), VIEWPORT);
    parked.detach('a');
    // Running and connected.
    registry.create(store.add(makeRecord({ id: 'live' })));
    const live = registry.host('live')!;
    await vi.waitFor(() => expect(live.state).toBe('ready'));
    await vi.advanceTimersByTimeAsync(5 * TTL);
    expect(registry.host('parked')).toBe(parked);
    expect(registry.host('live')).toBe(live);
    expect(live.state).toBe('ready');
    await registry.shutdown();
  });

  it('terminate pins the runtime while it runs; the ended runtime goes after the TTL', async () => {
    const { store, registry } = setup();
    registry.create(store.add(makeRecord({ id: 's3' })));
    const runtime = registry.host('s3')!;
    await vi.waitFor(() => expect(runtime.state).toBe('ready'));
    await registry.terminate('s3', 'user-1');
    expect(runtime.state).toBe('ended');
    expect(registry.host('s3')).toBe(runtime);
    await vi.advanceTimersByTimeAsync(TTL);
    expect(registry.host('s3')).toBeUndefined();
    await registry.shutdown();
  });

  it('reopen while the idle timer expires: never evicted mid-reopen, the new runtime stays', async () => {
    const { store, registry, load } = setup();
    store.add(ended('s4'));
    const old = await load('s4');
    // Reopen stalls on the store right as the idle TTL runs out.
    const get = store.get.bind(store);
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    store.get = async (id) => {
      if (++calls === 1) await stalled;
      return get(id);
    };
    const reopened = registry.reopen('s4', 'user-1');
    await vi.advanceTimersByTimeAsync(TTL + 1);
    expect(registry.host('s4')).toBe(old); // pinned: not evicted
    expect(old.attachmentCount).toBe(0);
    release();
    await reopened;
    const fresh = registry.host('s4')!;
    expect(fresh).not.toBe(old);
    await vi.waitFor(() => expect(fresh.state).toBe('ready'));
    await vi.advanceTimersByTimeAsync(3 * TTL);
    expect(registry.host('s4')).toBe(fresh);
    await registry.shutdown();
  });

  it('retry of an ended session leaves it idle: the timer is re-armed after the operation', async () => {
    const { store, registry } = setup();
    store.add(ended('s5'));
    await registry.retry('s5', 'user-1'); // loads it; retry does nothing for an ended session
    const runtime = registry.host('s5')!;
    expect(runtime.idle).toBe(true);
    await vi.advanceTimersByTimeAsync(TTL);
    expect(registry.host('s5')).toBeUndefined();
    await registry.shutdown();
  });

  it('loads after an eviction share one fresh runtime (never two for one session)', async () => {
    const { store, registry, load } = setup();
    store.add(ended('s6'));
    const first = await load('s6');
    await vi.advanceTimersByTimeAsync(TTL);
    expect(registry.host('s6')).toBeUndefined();
    const [a, b] = await Promise.all([load('s6'), load('s6')]);
    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(registry.host('s6')).toBe(a);
    await registry.shutdown();
  });

  it('daemon shutdown stops pending evictions', async () => {
    const { store, registry, load } = setup();
    store.add(ended('s7'));
    const runtime = await load('s7');
    await registry.shutdown();
    await vi.advanceTimersByTimeAsync(2 * TTL);
    expect(registry.host('s7')).toBe(runtime); // shut down with the others, not evicted
    expect(runtime.idle).toBe(false);
    expect(await registry.attachable('s-unknown')).toBeNull();
  });
});
