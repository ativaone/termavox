// T0: ending a session that is not connected reaches the server (plan D-30): the runtime's
// one-shot remote cleanup, its failures (the session ends anyway, `remoteCleanup: 'pending'`),
// host keys failing closed, no prompt ever, shutdown during the cleanup; the adopted session's
// socket and `adopt_target_gone`; the background sweep hook after ready.
import { ErrorCode, TermdockError } from '@termdock/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteSweeper } from '../../src/core/remote-sessions.ts';
import { type SessionRecord, TransportError } from '../../src/core/types.ts';
import { killServerCommand } from '../../src/drivers/tmux-control/commands.ts';
import { probeCommand } from '../../src/probe/index.ts';
import {
  type FakeExecResult,
  type FakeTransportBehavior,
  fakeTmuxDrivers,
  harness,
  TEST_KEY,
  TMUX_PROBE,
  until,
} from './fakes.ts';

const SID = 'session-1';
/** `installationId: 'install-1'` (harness) → prefix `install1`; makeRecord's token. */
const SOCKET = 'td-install1-abcdefghijkl';
const KILL = killServerCommand({ tmuxPath: '/usr/bin/tmux', socket: SOCKET });

/** A tmux-protected session that is not connected (waiting to reconnect), tmux path stored. */
const OFFLINE: Partial<SessionRecord> = {
  protection: 'tmux-control',
  state: 'reconnecting',
  status: 'reconnecting',
  lastReadyAt: 1,
  remoteIdentity: { sessionCreated: 1, panePid: 10 },
  tmuxPath: '/usr/bin/tmux',
};

/** Answers the kill command (default exit 0); everything else falls back to the probe. */
function killing(
  answer: () => FakeExecResult | Promise<FakeExecResult> = () => ({ code: 0 }),
): (attempt: number) => FakeTransportBehavior {
  return () => ({
    probe: TMUX_PROBE,
    exec: (command) => (command.includes('kill-server') ? answer() : undefined),
  });
}

describe('terminate while not connected (plan D-30)', () => {
  it('connects just to kill the tmux server: stays terminating meanwhile, then ends cleanly', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      record: OFFLINE,
      behavior: killing(async () => {
        await gate;
        return { code: 0 };
      }),
    });
    const rt = h.runtime();
    const done = rt.terminate();
    await until(() => h.factory.created[0]?.commands.length === 1);
    expect(rt.state).toBe('terminating');
    expect(rt.idle).toBe(false); // never evicted mid-cleanup
    expect(h.store.records.get(SID)?.desiredState).toBe('terminated'); // boot never restores it
    // The stored tmux path is used: no probe, just the kill on the session's own socket.
    expect(h.factory.created[0]!.commands).toEqual([KILL]);
    release();
    await done;
    const transport = h.factory.last;
    expect(transport.closed).toBe(true);
    expect(h.factory.created).toHaveLength(1);
    expect(h.store.events.map((e) => e.type)).toContain('remote_cleanup');
    expect(h.notifier.ofType('session.status').at(-1)).toEqual({
      type: 'session.status',
      sessionId: SID,
      status: 'ended',
      state: 'ended',
      detail: 'user_terminated',
    });
    expect(h.store.records.get(SID)).toMatchObject({
      state: 'ended',
      desiredState: 'terminated',
      endReason: 'user_terminated',
    });
    expect(rt.idle).toBe(true);
  });

  it('probes for the tmux path only when none is stored', async () => {
    const h = harness({ record: { ...OFFLINE, tmuxPath: null }, behavior: killing() });
    await h.runtime().terminate();
    expect(h.factory.last.commands).toEqual([probeCommand(), KILL]);
    expect(h.store.events.map((e) => e.type)).toContain('remote_cleanup');
  });

  it('an adopted session ends the tmux server it was adopted from', async () => {
    const adopted = 'td-zzzzzzzz-mnopqrstuvwx';
    const h = harness({ record: { ...OFFLINE, tmuxSocket: adopted }, behavior: killing() });
    await h.runtime().terminate();
    expect(h.factory.last.commands).toEqual([
      killServerCommand({ tmuxPath: '/usr/bin/tmux', socket: adopted }),
    ]);
  });

  it('a connect failure: the session ends anyway, event code, `remoteCleanup: pending`', async () => {
    const h = harness({
      record: OFFLINE,
      behavior: () => ({
        connect: async () => {
          throw new TransportError(ErrorCode.HostUnreachable, 'refused', true);
        },
      }),
    });
    await h.runtime().terminate();
    expect(h.store.events.filter((e) => e.type.startsWith('remote_cleanup'))).toEqual([
      { sessionId: SID, type: 'remote_cleanup_failed', detail: { code: 'HOST_UNREACHABLE' } },
    ]);
    // The `ended` detail stays the EndReason; the pending cleanup is a field of its own.
    expect(h.notifier.ofType('session.status').at(-1)).toEqual({
      type: 'session.status',
      sessionId: SID,
      status: 'ended',
      state: 'ended',
      detail: 'user_terminated',
      remoteCleanup: 'pending',
    });
    expect(h.store.records.get(SID)).toMatchObject({
      state: 'ended',
      endReason: 'user_terminated',
    });
    expect(h.factory.last.closed).toBe(true);
  });

  it('an unknown host key fails closed: nothing recorded as pending, no prompt', async () => {
    const h = harness({
      record: OFFLINE,
      behavior: () => ({
        connect: async (hooks) => {
          hooks.onHostKey({ ...TEST_KEY }, 'unknown');
          throw new TermdockError(ErrorCode.HostKeyRejected, 'unknown host key', {
            pending: { ...TEST_KEY },
          });
        },
      }),
    });
    await h.runtime().terminate();
    expect(h.hostKeys.pending).toEqual([]);
    expect(h.notifier.ofType('hostkey.prompt')).toEqual([]);
    expect(h.store.transitions(SID).map(([state]) => state)).toEqual(['terminating', 'ended']);
    expect(h.store.events.find((e) => e.type === 'remote_cleanup_failed')?.detail).toEqual({
      code: 'HOST_KEY_REJECTED',
    });
    expect(h.notifier.ofType('session.status').at(-1)?.remoteCleanup).toBe('pending');
  });

  it('keyboard-interactive never prompts: answered with nothing at once', async () => {
    const answers: Array<string[] | null> = [];
    const h = harness({
      record: OFFLINE,
      behavior: () => ({
        connect: async (hooks) => {
          hooks.onHostKey({ ...TEST_KEY }, 'trusted');
          answers.push(
            await hooks.onKeyboardInteractive({
              name: '',
              instructions: 'MFA',
              prompts: [{ text: 'OTP: ', echo: false }],
            }),
          );
          throw new TermdockError(ErrorCode.AuthTimeout, 'keyboard-interactive prompt expired');
        },
      }),
    });
    const rt = h.runtime({ promptTimeoutMs: 60_000 });
    const started = Date.now();
    await rt.terminate();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(answers).toEqual([null]);
    expect(h.notifier.ofType('auth.prompt')).toEqual([]);
    expect(rt.pendingPrompt()).toBeNull();
    expect(h.store.transitions(SID).map(([state]) => state)).toEqual(['terminating', 'ended']);
    expect(h.store.events.find((e) => e.type === 'remote_cleanup_failed')?.detail).toEqual({
      code: 'AUTH_TIMEOUT',
    });
  });

  it('a deleted server is never connected to: NOT_FOUND, pending', async () => {
    const h = harness({ record: { ...OFFLINE, serverId: null } });
    await h.runtime().terminate();
    expect(h.factory.created).toHaveLength(0);
    expect(h.store.events.find((e) => e.type === 'remote_cleanup_failed')?.detail).toEqual({
      code: 'NOT_FOUND',
    });
    expect(h.notifier.ofType('session.status').at(-1)?.remoteCleanup).toBe('pending');
  });

  it('the connect is bounded, and a failing kill is a failure too', async () => {
    const hanging = harness({
      record: OFFLINE,
      behavior: () => ({
        connect: (_hooks, signal) =>
          new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      }),
    });
    await hanging.runtime({ cleanupConnectTimeoutMs: 30 }).terminate();
    expect(hanging.store.events.find((e) => e.type === 'remote_cleanup_failed')?.detail).toEqual({
      code: 'HOST_UNREACHABLE',
    });

    const failing = harness({ record: OFFLINE, behavior: killing(() => ({ code: 1 })) });
    await failing.runtime().terminate();
    expect(failing.store.events.find((e) => e.type === 'remote_cleanup_failed')?.detail).toEqual({
      code: 'CHANNEL_FAILED',
    });
    expect(failing.store.records.get(SID)?.state).toBe('ended');
  });

  it('nothing to clean: protection none or never chosen, and a live driver kills it itself', async () => {
    for (const protection of ['none', null] as const) {
      const h = harness({ record: { ...OFFLINE, protection } });
      await h.runtime().terminate();
      expect(h.factory.created).toHaveLength(0);
      expect(h.store.events.some((e) => e.type.startsWith('remote_cleanup'))).toBe(false);
      expect(h.notifier.ofType('session.status').at(-1)).not.toHaveProperty('remoteCleanup');
    }

    const terminate = vi.fn(async () => {});
    const live = harness({
      record: { ...OFFLINE, state: 'new' },
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: fakeTmuxDrivers(async () => {}),
    });
    const drivers = live.drivers;
    const original = drivers.tmuxControl!;
    drivers.tmuxControl = (opts) => ({ ...original(opts), terminate });
    const rt = live.runtime();
    await rt.start();
    expect(rt.state).toBe('ready');
    await rt.terminate();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(live.factory.created).toHaveLength(1); // the session's own connection only
    expect(live.store.events.some((e) => e.type.startsWith('remote_cleanup'))).toBe(false);
  });

  it('a second terminate shares the first; shutdown aborts a running cleanup promptly', async () => {
    const h = harness({ record: OFFLINE, behavior: killing(() => ({ hang: true })) });
    const rt = h.runtime();
    const first = rt.terminate();
    expect(rt.terminate()).toBe(first);
    await until(() => h.factory.created[0]?.commands.length === 1);
    const started = Date.now();
    await rt.shutdown();
    await first;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.factory.created).toHaveLength(1);
    expect(h.store.events.find((e) => e.type === 'remote_cleanup_failed')?.detail).toEqual({
      code: 'SHUTTING_DOWN',
    });
    expect(h.store.records.get(SID)).toMatchObject({
      state: 'ended',
      desiredState: 'terminated',
      endReason: 'user_terminated',
    });
    expect(h.notifier.ofType('session.status').at(-1)?.remoteCleanup).toBe('pending');
  });
});

describe('adopted sessions and the sweep hook (plan D-30)', () => {
  it('launches on the adopted socket; a created session means the target was gone', async () => {
    for (const created of [true, false]) {
      const seen: string[] = [];
      const h = harness({
        record: {
          protection: 'tmux-control',
          lastReadyAt: 5,
          tmuxSocket: 'td-zzzzzzzz-abcdefghijkl',
        },
        behavior: () => ({ probe: TMUX_PROBE }),
        drivers: fakeTmuxDrivers(async (_ctx, opts) => {
          seen.push(opts.socket);
          expect(opts.previousIdentity).toBeNull();
          opts.onIdentity({ sessionCreated: 7, panePid: 70 }, false, created);
        }),
      });
      const rt = h.runtime();
      await rt.start();
      expect(rt.state).toBe('ready');
      expect(seen).toEqual(['td-zzzzzzzz-abcdefghijkl']);
      // Status said Restoring, not Connecting, on the way (lastReadyAt was set).
      expect(h.notifier.ofType('session.status')[0]?.status).toBe('restoring');
      expect(h.store.events.some((e) => e.type === 'adopt_target_gone')).toBe(created);
      await rt.shutdown();
    }
  });

  it('a ready session hands its own connection to the sweeper; stale once the attempt ends', async () => {
    const calls: Array<{ target: unknown; tmuxPath: string; live: () => boolean }> = [];
    const sweeper = {
      sweep: (target: unknown, _transport: unknown, tmuxPath: string, live: () => boolean) => {
        calls.push({ target, tmuxPath, live });
        return null;
      },
    } as unknown as RemoteSweeper;
    const h = harness({
      record: { protection: 'tmux-control' },
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: fakeTmuxDrivers(async () => {}),
    });
    const rt = h.runtime({ sweeper });
    await rt.start();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      target: {
        userId: 'user-1',
        serverId: 'server-1',
        hostname: '127.0.0.1',
        port: 22,
        username: 'td',
      },
      tmuxPath: '/usr/bin/tmux',
    });
    expect(calls[0]!.live()).toBe(true);
    await rt.terminate();
    expect(calls[0]!.live()).toBe(false);

    // No tmux on the host: nothing to sweep.
    const plain = harness();
    await plain.runtime({ sweeper }).start();
    expect(calls).toHaveLength(1);
  });
});
