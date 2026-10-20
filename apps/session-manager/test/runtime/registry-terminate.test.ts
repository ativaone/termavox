// T0: terminate through the registry while a remote cleanup runs (plan D-30): the answer comes
// within the bound, races (a second terminate, Reopen, Retry, eviction pins), "End all
// sessions", the process-wide cleanup limit, boot ending interrupted terminations, and daemon
// shutdown during a cleanup.
import { ErrorCode, TermavoxError } from '@termavox/shared';
import { describe, expect, it } from 'vitest';
import { createDriverFactory } from '../../src/core/driver-factory.ts';
import { REMOTE_CLEANUP_CONCURRENCY, SessionRegistry } from '../../src/core/session-registry.ts';
import type { SessionRecord } from '../../src/core/types.ts';
import {
  type FakeTransportBehavior,
  FakeTransportFactory,
  MemoryHostKeyStore,
  MemorySessionStore,
  makeRecord,
  RecordingNotifier,
  until,
} from './fakes.ts';

const USER = 'user-1';
const ANSWER_MS = 60;

/** A tmux-protected session that is not connected (it waits to reconnect). */
function offline(id: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return makeRecord({
    id,
    protection: 'tmux-control',
    state: 'reconnecting',
    status: 'reconnecting',
    lastReadyAt: 1,
    tmuxPath: '/usr/bin/tmux',
    ...extra,
  });
}

/** Kill commands wait for `release()`; `pending` counts the ones waiting right now. */
function gatedKills() {
  const waiting: Array<() => void> = [];
  let max = 0;
  const behavior = (): FakeTransportBehavior => ({
    exec: (command) => {
      if (!command.includes('kill-server')) return undefined;
      return new Promise((resolve) => {
        waiting.push(() => resolve({ code: 0 }));
        max = Math.max(max, waiting.length);
      });
    },
  });
  return {
    behavior,
    get pending() {
      return waiting.length;
    },
    get max() {
      return max;
    },
    releaseAll() {
      for (const release of waiting.splice(0)) release();
    },
  };
}

function setup(behavior?: (attempt: number) => FakeTransportBehavior, idleTtlMs = 60_000) {
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
    idleTtlMs,
    terminateAnswerMs: ANSWER_MS,
    runtime: { resizeDebounceMs: 1 },
  });
  return { store, notifier, factory, registry };
}

describe('registry terminate with a remote cleanup (plan D-30)', () => {
  it('answers within the bound while the cleanup runs; the end arrives later; never evicted meanwhile', async () => {
    const kills = gatedKills();
    const { store, notifier, registry } = setup(kills.behavior, 5);
    store.add(offline('s1'));
    const started = Date.now();
    await registry.terminate('s1', USER);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(ANSWER_MS - 5);
    expect(waited).toBeLessThan(1_000);
    const runtime = registry.host('s1')!;
    expect(runtime.state).toBe('terminating');
    expect(kills.pending).toBe(1);

    // A second terminate shares the first one: no second cleanup, answered within the bound too.
    await registry.terminate('s1', USER);
    expect(kills.pending).toBe(1);
    // Retry does nothing to a session that is ending.
    await registry.retry('s1', USER);
    expect(runtime.state).toBe('terminating');

    // Idle TTL 5 ms: the runtime still terminating is never evicted, even after the pin is gone.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(registry.host('s1')).toBe(runtime);

    kills.releaseAll();
    await until(() => runtime.state === 'ended');
    expect(notifier.ofType('session.status').at(-1)).toMatchObject({
      state: 'ended',
      detail: 'user_terminated',
    });
    // Ended and idle now: evicted after its TTL.
    await until(() => registry.host('s1') === undefined);
    await registry.shutdown();
  });

  it('Reopen during the cleanup waits for it within the bound, else 409; after the end it works', async () => {
    const kills = gatedKills();
    const { store, registry } = setup(kills.behavior);
    store.add(offline('s1'));
    await registry.terminate('s1', USER);
    const refused = await registry.reopen('s1', USER).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TermavoxError);
    expect((refused as TermavoxError).code).toBe(ErrorCode.Conflict);
    expect(registry.host('s1')?.state).toBe('terminating');

    // A cleanup that finishes while Reopen waits: Reopen goes ahead.
    const reopening = registry.reopen('s1', USER);
    await new Promise((resolve) => setTimeout(resolve, 10));
    kills.releaseAll();
    await expect(reopening).resolves.toEqual({ sessionId: 's1' });
    expect(store.records.get('s1')).toMatchObject({ desiredState: 'running', endReason: null });
    await registry.shutdown();
  });

  it('End all sessions: every non-ended session is ending at once; cleanups 4 at a time', async () => {
    const kills = gatedKills();
    const { store, registry } = setup(kills.behavior);
    const protectedIds = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    for (const id of protectedIds) store.add(offline(id));
    store.add(offline('n1', { protection: 'none' }));
    store.add(offline('done', { state: 'ended', status: 'ended', desiredState: 'terminated' }));
    store.add(offline('theirs', { userId: 'user-2' }));

    const started = Date.now();
    const terminated = await registry.terminateAll(USER);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(terminated).toBe(7);
    for (const id of [...protectedIds, 'n1']) {
      expect(['terminating', 'ended']).toContain(registry.host(id)?.state);
      expect(store.records.get(id)?.desiredState).toBe('terminated');
    }
    expect(registry.host('n1')?.state).toBe('ended'); // nothing remote to clean
    expect(registry.host('theirs')).toBeUndefined(); // another user's session is untouched
    await until(() => kills.pending === REMOTE_CLEANUP_CONCURRENCY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kills.pending).toBe(REMOTE_CLEANUP_CONCURRENCY);

    // The rest follow as slots free up; never more than 4 at once.
    while (protectedIds.some((id) => registry.host(id)?.state !== 'ended')) {
      kills.releaseAll();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(kills.max).toBe(REMOTE_CLEANUP_CONCURRENCY);
    await registry.shutdown();
  });

  it('boot ends sessions the previous daemon was still terminating instead of restoring them', async () => {
    const { store, factory, registry } = setup();
    store.add(
      offline('cut', { state: 'terminating', status: 'ended', desiredState: 'terminated' }),
    );
    store.add(offline('running', { protection: 'none', state: 'ready', status: 'connected' }));
    const summary = await registry.restore();
    expect(summary).toEqual({ restored: 1, endedInterrupted: 1 });
    expect(store.records.get('cut')).toMatchObject({
      state: 'ended',
      desiredState: 'terminated',
      endReason: 'user_terminated',
    });
    expect(registry.host('cut')).toBeUndefined();
    expect(factory.created).toHaveLength(1); // only the restorable session connected
    await registry.shutdown();
  });

  it('a daemon shutdown during a cleanup ends the session promptly, cleanup pending', async () => {
    const kills = gatedKills();
    const { store, notifier, registry } = setup(kills.behavior);
    store.add(offline('s1'));
    await registry.terminate('s1', USER);
    expect(kills.pending).toBe(1);
    const started = Date.now();
    await registry.shutdown(5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(store.records.get('s1')).toMatchObject({ state: 'ended', desiredState: 'terminated' });
    expect(store.events.find((e) => e.type === 'remote_cleanup_failed')?.detail).toEqual({
      code: 'SHUTTING_DOWN',
    });
    expect(notifier.ofType('session.status').at(-1)).toMatchObject({
      state: 'ended',
      remoteCleanup: 'pending',
    });
  });
});
