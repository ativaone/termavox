import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDriverFactory } from '../../src/core/driver-factory.ts';
import {
  MAX_IDLE_RUNTIMES_PER_USER,
  RUNTIME_IDLE_TTL_MS,
  SessionRegistry,
  type SessionRegistryOptions,
} from '../../src/core/session-registry.ts';
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

function setup(options: Partial<SessionRegistryOptions> = {}) {
  const store = new MemorySessionStore();
  const registry = new SessionRegistry({
    store,
    hostKeys: new MemoryHostKeyStore(),
    transports: new FakeTransportFactory(),
    drivers: createDriverFactory(),
    notifier: new RecordingNotifier(),
    installationId: 'install-1',
    runtime: { resizeDebounceMs: 1, lagPollMs: 5 },
    ...options,
  });
  const load = async (id: string) => (await registry.attachable(id)) as SessionRuntime;
  return { store, registry, load };
}

function ended(id: string, userId = 'user-1'): SessionRecord {
  return makeRecord({
    id,
    userId,
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

describe('idle runtimes per user (cap)', () => {
  const CAP = 3;
  const loaded = (registry: SessionRegistry, ids: string[]) =>
    ids.filter((id) => registry.host(id) !== undefined);

  it(`defaults to ${MAX_IDLE_RUNTIMES_PER_USER} idle runtimes per user`, async () => {
    const { store, registry, load } = setup();
    const ids = Array.from({ length: MAX_IDLE_RUNTIMES_PER_USER + 4 }, (_, i) => `d${i}`);
    for (const id of ids) store.add(ended(id));
    for (const id of ids) await load(id);
    expect(loaded(registry, ids)).toEqual(ids.slice(4));
    await registry.shutdown();
  });

  it('attaching to more ended sessions than the cap evicts the least recently idle at once', async () => {
    const { store, registry, load } = setup({ maxIdleRuntimesPerUser: CAP });
    const ids = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'];
    for (const id of ids) store.add(ended(id));
    const first = await load('e1');
    await load('e2');
    await load('e3');
    // e1 was used again (attach, detach): now e2 is the least recently idle.
    first.attach(new FakeAttachment('a'), VIEWPORT);
    first.detach('a');
    await load('e4');
    expect(loaded(registry, ids)).toEqual(['e1', 'e3', 'e4']);
    await load('e5');
    await load('e6');
    // No timer ran: the cap evicts right away, never more than CAP idle runtimes stay loaded.
    expect(loaded(registry, ids)).toEqual(['e4', 'e5', 'e6']);
    expect(registry.size).toBe(CAP);
    // The evicted runtime is closed for good; a later attach loads the session again.
    first.attach(new FakeAttachment('late'), VIEWPORT);
    expect(first.attachmentCount).toBe(0);
    const again = await load('e1');
    expect(again).not.toBe(first);
    expect(loaded(registry, ids)).toEqual(['e1', 'e5', 'e6']);
    await registry.shutdown();
  });

  it('operations on ended sessions (retry, stop) load runtimes under the same cap', async () => {
    const { store, registry } = setup({ maxIdleRuntimesPerUser: CAP });
    const ids = ['o1', 'o2', 'o3', 'o4', 'o5'];
    for (const id of ids) store.add(ended(id));
    for (const id of ids) await registry.retry(id, 'user-1');
    await expect(registry.stop('o1', 'user-1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(loaded(registry, ids)).toEqual(['o1', 'o4', 'o5']);
    await registry.shutdown();
  });

  it('never evicts attached, running or pinned runtimes, nor another user’s idle ones', async () => {
    const { store, registry, load } = setup({ maxIdleRuntimesPerUser: CAP });
    // Attached: not idle.
    store.add(ended('watched'));
    const watched = await load('watched');
    watched.attach(new FakeAttachment('w'), VIEWPORT);
    // Running and connected, and parked on a failure (meant to run): not idle.
    registry.create(store.add(makeRecord({ id: 'live' })));
    const live = registry.host('live')!;
    await vi.waitFor(() => expect(live.state).toBe('ready'));
    store.add(
      makeRecord({ id: 'parked', state: 'failed', status: 'disconnected', lastReadyAt: 1 }),
    );
    const parked = await load('parked');
    // Pinned: a Retry of an idle runtime stalls on the store while the others load.
    store.add(ended('pinned'));
    const pinned = await load('pinned');
    const get = store.get.bind(store);
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.get = async (id) => {
      if (id === 'pinned') await stalled;
      return get(id);
    };
    const retrying = registry.retry('pinned', 'user-1');
    // Another user's idle runtimes, as many as the cap.
    const others = ['b1', 'b2', 'b3'];
    for (const id of others) store.add(ended(id, 'user-2'));
    for (const id of others) await load(id);

    const ids = ['e1', 'e2', 'e3', 'e4', 'e5'];
    for (const id of ids) store.add(ended(id));
    for (const id of ids) await load(id);
    // The pinned runtime counts towards the cap but stays: two of the newest remain with it.
    expect(registry.host('pinned')).toBe(pinned);
    expect(loaded(registry, ids)).toEqual(['e4', 'e5']);
    expect(registry.host('watched')).toBe(watched);
    expect(registry.host('live')).toBe(live);
    expect(live.state).toBe('ready');
    expect(registry.host('parked')).toBe(parked);
    expect(loaded(registry, others)).toEqual(others);

    release();
    await retrying;
    // Unpinned and idle again (the most recent): still CAP idle runtimes for user-1.
    expect(registry.host('pinned')).toBe(pinned);
    expect(loaded(registry, ids)).toEqual(['e4', 'e5']);
    await registry.shutdown();
  });
});
