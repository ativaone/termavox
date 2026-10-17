import { ErrorCode } from '@termdock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextRetry, RECONNECT_WINDOW_MS } from '../../src/core/backoff.ts';
import { TransportError } from '../../src/core/types.ts';
import { harness, until } from './fakes.ts';

const SID = 'session-1';
const unreachable = () => ({
  connect: async () => {
    throw new TransportError(ErrorCode.HostUnreachable, 'down', true);
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe('retry rounds (plan D-31)', () => {
  it('a session that never connected makes 4 attempts, then waits as failed with the last code', async () => {
    vi.useFakeTimers({ now: 0 });
    const h = harness({ behavior: unreachable });
    const rt = h.runtime({ random: () => 0.5 }); // no jitter
    void rt.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.factory.times).toEqual([0, 5_000, 20_000, 50_000]);
    expect(rt.state).toBe('failed');
    expect(rt.live()).toMatchObject({ status: 'disconnected', statusDetail: 'HOST_UNREACHABLE' });
    // Persisted as failed: boot does not restart it.
    expect(await h.store.listRestorable()).toEqual([]);
    expect(h.store.events.map((e) => e.type)).toContain('retries_exhausted');

    const statuses = h.notifier.ofType('session.status');
    const waits = statuses.filter((m) => m.state === 'reconnecting');
    expect(waits.map((m) => [m.retryInMs, m.attempt, m.maxAttempts])).toEqual([
      [5_000, 2, 4],
      [15_000, 3, 4],
      [30_000, 4, 4],
    ]);
    // The attempts carry the round's progress too, except the very first one.
    const connecting = statuses.filter((m) => m.state === 'connecting');
    expect(connecting.map((m) => m.attempt)).toEqual([undefined, 2, 3, 4]);
    expect(statuses.at(-1)).toMatchObject({ state: 'failed', detail: 'HOST_UNREACHABLE' });
    expect(statuses.at(-1)?.attempt).toBeUndefined();

    // A client that connects later gets the round's progress (the summary has none).
    expect(rt.retryStatus()).toBeNull(); // failed: the round is over
    // Retry starts a fresh round.
    await rt.retry();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.factory.times.slice(4)).toEqual([300_000, 305_000]);
    expect(h.notifier.ofType('session.status').at(-1)).toMatchObject({ attempt: 3 });
    await vi.advanceTimersByTimeAsync(5_000); // 10 s of the 15 s wait remain
    expect(rt.retryStatus()).toEqual({
      type: 'session.status',
      sessionId: SID,
      status: 'reconnecting',
      state: 'reconnecting',
      retryInMs: 10_000,
      attempt: 3,
      maxAttempts: 4,
    });
    await rt.shutdown();
  });

  it('a lost connection retries after 2, 5, 10, 30 s, then every 60 s, for 30 minutes', async () => {
    vi.useFakeTimers({ now: 0 });
    const h = harness({ behavior: (n) => (n === 0 ? {} : unreachable()) });
    const rt = h.runtime({ random: () => 0.5 });
    void rt.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.state).toBe('ready');
    h.factory.last.lose();
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MS + 120_000);

    const attempts = h.factory.times.slice(1);
    expect(attempts.slice(0, 6)).toEqual([2_000, 7_000, 17_000, 47_000, 107_000, 167_000]);
    // The last attempt starts within the window; the next one would not.
    expect(attempts.at(-1)).toBe(1_787_000);
    expect(attempts).toHaveLength(33);
    expect(rt.state).toBe('failed');
    expect(rt.live().statusDetail).toBe('HOST_UNREACHABLE');
    const waits = h.notifier.ofType('session.status').filter((m) => m.state === 'reconnecting');
    expect(new Set(waits.map((m) => m.retryUntil))).toEqual(new Set([RECONNECT_WINDOW_MS]));
    expect(waits.every((m) => m.attempt === undefined)).toBe(true);
    await rt.shutdown();
  });

  it('applies ±20 % jitter, and a reconnect round ends where the next wait would cross the window', () => {
    const first = { kind: 'first' } as const;
    expect(nextRetry(first, 0, 0, () => 0)).toEqual({ delayMs: 4_000, attempt: 2, maxAttempts: 4 });
    expect(nextRetry(first, 2, 0, () => 0.999_999)?.delayMs).toBe(36_000);
    expect(nextRetry(first, 3, 0)).toBeNull();
    const lost = { kind: 'reconnect', since: 1_000 } as const;
    expect(nextRetry(lost, 0, 1_000, () => 0.5)).toEqual({
      delayMs: 2_000,
      retryUntil: 1_000 + RECONNECT_WINDOW_MS,
    });
    expect(nextRetry(lost, 9, 1_000, () => 0)?.delayMs).toBe(48_000);
    expect(nextRetry(lost, 9, RECONNECT_WINDOW_MS - 50_000, () => 0.5)).toBeNull();
  });
});

describe('Stop (plan D-31)', () => {
  it('ends the round while it waits: failed RETRIES_STOPPED, no more attempts until Retry', async () => {
    vi.useFakeTimers({ now: 0 });
    const h = harness({ behavior: unreachable });
    const rt = h.runtime({ random: () => 0.5 });
    void rt.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.state).toBe('reconnecting');

    expect(await rt.stopRetrying('user-1')).toBe(true);
    expect(rt.live()).toMatchObject({ state: 'failed', statusDetail: 'RETRIES_STOPPED' });
    expect(h.store.events.find((e) => e.type === 'retries_stopped')?.actorUserId).toBe('user-1');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.factory.times).toEqual([0]);
    expect(await h.store.listRestorable()).toEqual([]);
    // Nothing left to stop.
    expect(await rt.stopRetrying('user-1')).toBe(false);

    await rt.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.factory.times).toEqual([0, 120_000]);
    expect(rt.state).toBe('reconnecting');
    await rt.shutdown();
  });

  it('cuts an attempt in flight, and is refused once the session is connected', async () => {
    const hanging = harness({
      behavior: () => ({
        connect: (_hooks, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      }),
    });
    const rt = hanging.runtime();
    void rt.start();
    await until(() => rt.state === 'connecting');
    expect(await rt.stopRetrying('user-1')).toBe(true);
    expect(rt.state).toBe('failed');
    await until(() => hanging.factory.last.closed);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hanging.factory.created).toHaveLength(1);
    expect(rt.state).toBe('failed');
    await rt.shutdown();

    const connected = harness();
    const rt2 = connected.runtime();
    await rt2.start();
    expect(rt2.state).toBe('ready');
    expect(await rt2.stopRetrying('user-1')).toBe(false);
    expect(rt2.state).toBe('ready');
    await rt2.shutdown();
  });
});

describe("following the server's target until the first connection (plan D-31)", () => {
  const fixed = { kind: 'ssh' as const, hostname: '10.0.0.9', port: 2222, username: 'ops' };

  it('a session that never connected uses the server as it is now; a connected one keeps its own', async () => {
    const h = harness({ record: { serverTarget: { ...fixed, credentialId: 'cred-2' } } });
    const rt = h.runtime();
    await rt.start();
    expect(rt.state).toBe('ready');
    expect(h.factory.targets[0]).toEqual({ ...fixed, credentialId: 'cred-2' });
    expect(h.store.records.get(SID)?.target).toEqual({ ...fixed, credentialId: 'cred-2' });
    expect(h.store.events.find((e) => e.type === 'target_followed')?.detail).toEqual({
      hostname: '10.0.0.9',
      port: 2222,
    });

    // Connected once: a later edit of the server no longer moves the session (§9).
    h.store.records.get(SID)!.serverTarget = {
      ...fixed,
      hostname: '10.0.0.10',
      credentialId: null,
    };
    h.factory.last.lose();
    await until(() => rt.state === 'reconnecting');
    await rt.retry();
    await until(() => rt.state === 'ready');
    expect(h.factory.targets[1]).toEqual({ ...fixed, credentialId: 'cred-2' });
    expect(h.store.events.filter((e) => e.type === 'target_followed')).toHaveLength(1);
    await rt.shutdown();
  });

  it('a local server, a deleted one, or an unchanged target leaves the session as it is', async () => {
    const same = harness({
      record: {
        serverTarget: {
          kind: 'ssh',
          hostname: '127.0.0.1',
          port: 22,
          username: 'td',
          credentialId: null,
        },
      },
    });
    const rt = same.runtime();
    await rt.start();
    expect(same.store.updates.some((u) => u.patch.target !== undefined)).toBe(false);
    await rt.shutdown();

    const local = harness({
      record: {
        serverTarget: {
          kind: 'local',
          hostname: 'localhost',
          port: 0,
          username: '',
          credentialId: null,
        },
      },
    });
    const rt2 = local.runtime();
    await rt2.start();
    expect(local.factory.targets[0]?.hostname).toBe('127.0.0.1');
    await rt2.shutdown();
  });
});
