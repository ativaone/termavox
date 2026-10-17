import { ErrorCode, TermdockError } from '@termdock/shared';
import { describe, expect, it } from 'vitest';
import {
  encode,
  FakeAttachment,
  fakeTmuxDrivers,
  harness,
  TEST_ADDRESS,
  TEST_KEY,
  TMUX_PROBE,
  until,
} from './fakes.ts';

const SID = 'session-1';

function screenText(rt: { emulator: { terminal: import('@xterm/headless').Terminal } }): string {
  const buffer = rt.emulator.terminal.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)!.translateToString(true));
  return lines.join('\n');
}

describe('SessionRuntime state machine', () => {
  it('persists every transition and maps status through wasReady (Connecting… vs Restoring…)', async () => {
    const h = harness();
    const rt = h.runtime();
    await rt.start();
    expect(h.store.transitions(SID)).toEqual([
      ['connecting', 'connecting'],
      ['verifying_host', 'connecting'],
      ['authenticating', 'connecting'],
      ['probing', 'connecting'],
      ['starting', 'connecting'],
      ['ready', 'connected'],
    ]);
    expect(h.store.records.get(SID)?.protection).toBe('none'); // probe found no tmux
    expect(h.store.records.get(SID)?.lastReadyAt).not.toBeNull();

    // Unprotected + auto-reopen: the reconnect starts a new shell in the same emulator.
    h.factory.last.lose();
    await until(() => rt.state === 'reconnecting');
    await rt.retry(); // "Retry now" skips the backoff wait
    await until(() => rt.state === 'ready');
    expect(h.store.transitions(SID).slice(6)).toEqual([
      ['reconnecting', 'reconnecting'],
      ['connecting', 'restoring'],
      ['verifying_host', 'restoring'],
      ['authenticating', 'restoring'],
      ['probing', 'restoring'],
      ['starting', 'restoring'],
      ['ready', 'connected'],
    ]);
    // The broadcast statuses mirror the persisted ones.
    expect(h.notifier.ofType('session.status').map((m) => m.status)).toEqual(
      h.store.transitions(SID).map(([, status]) => status),
    );
    await rt.emulator.flush();
    expect(screenText(rt)).toMatch(
      /── connection lost at \d\d:\d\d · new shell started \(session not protected\) ──/,
    );
    await rt.shutdown();
  });

  it('unknown host key: prompt, record pending, accept → trusted and reconnected', async () => {
    const h = harness({
      behavior: (attempt) =>
        attempt === 0
          ? {
              connect: async (hooks) => {
                hooks.onHostKey({ ...TEST_KEY }, 'unknown');
                throw new TermdockError(ErrorCode.HostKeyRejected, 'unknown', {
                  pending: { ...TEST_KEY },
                });
              },
            }
          : {},
    });
    const rt = h.runtime();
    await rt.start();
    expect(rt.state).toBe('awaiting_host_key');
    // Recorded for the session's address, with its server as the audit target.
    expect(h.hostKeys.pending).toEqual([
      { target: { ...TEST_ADDRESS, serverId: 'server-1' }, key: TEST_KEY },
    ]);
    const prompt = {
      type: 'hostkey.prompt',
      sessionId: SID,
      keyType: TEST_KEY.type,
      fingerprint: TEST_KEY.fingerprint,
      mismatch: false,
    };
    expect(h.notifier.ofType('hostkey.prompt')).toEqual([prompt]);
    expect(rt.pendingPrompt()).toEqual(prompt); // replayed to clients that connect later

    expect(await rt.hostKeyDecision('SHA256:other', true, 'user-1')).toBe(false);
    expect(await rt.hostKeyDecision(TEST_KEY.fingerprint, true, 'user-1')).toBe(true);
    await until(() => rt.state === 'ready');
    expect(h.hostKeys.trustedAt(TEST_ADDRESS)?.get(TEST_KEY.type)).toEqual(TEST_KEY);
    expect(h.factory.created).toHaveLength(2);
    await rt.shutdown();
  });

  it('host key mismatch and auth rejection fail without retrying; desired state stays running', async () => {
    for (const [code, details] of [
      [ErrorCode.HostKeyMismatch, { presented: { type: TEST_KEY.type, fingerprint: 'SHA256:x' } }],
      [ErrorCode.AuthRejected, undefined],
    ] as const) {
      const h = harness({
        behavior: () => ({
          connect: async () => {
            throw new TermdockError(code, 'nope', details);
          },
        }),
      });
      const rt = h.runtime();
      await rt.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rt.state).toBe('failed');
      expect(rt.live().status).toBe('disconnected');
      expect(h.factory.created).toHaveLength(1);
      expect(h.store.records.get(SID)?.desiredState).toBe('running');
      expect(h.notifier.ofType('session.status').at(-1)?.detail).toBe(code);
      if (code === ErrorCode.HostKeyMismatch) {
        expect(h.notifier.ofType('hostkey.prompt')).toMatchObject([{ mismatch: true }]);
      }
      await rt.shutdown();
    }
  });

  it('keyboard-interactive: relays the prompt, discards stale answers, parks after expiry', async () => {
    const answered: Array<string[] | null> = [];
    const h = harness({
      behavior: () => ({
        connect: async (hooks) => {
          hooks.onHostKey({ ...TEST_KEY }, 'trusted');
          const answers = await hooks.onKeyboardInteractive({
            name: '',
            instructions: 'MFA',
            prompts: [{ text: 'OTP: ', echo: false }],
          });
          answered.push(answers);
          if (!answers) throw new TermdockError(ErrorCode.AuthTimeout, 'expired');
        },
      }),
    });
    const rt = h.runtime({ promptTimeoutMs: 40 });

    void rt.start();
    await until(() => h.notifier.ofType('auth.prompt').length === 1);
    const { promptId } = h.notifier.ofType('auth.prompt')[0]!;
    expect(rt.state).toBe('awaiting_user_input');
    expect(rt.authResponse('stale-prompt', ['000000'])).toBe(false);
    expect(rt.authResponse(promptId, ['123456'])).toBe(true);
    await until(() => rt.state === 'ready');
    expect(answered).toEqual([['123456']]);

    // Expiry: the session stays in awaiting_user_input and does not retry on its own…
    h.factory.last.lose();
    await until(() => rt.state === 'reconnecting');
    await rt.retry();
    await until(() => h.notifier.ofType('auth.prompt').length === 2);
    await until(() => answered.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(rt.state).toBe('awaiting_user_input');
    expect(h.factory.created).toHaveLength(2);
    // …until someone attaches (or presses Retry): then a new prompt id is issued.
    rt.attach(new FakeAttachment('a1'), { cols: 80, rows: 24 });
    await until(() => h.notifier.ofType('auth.prompt').length === 3);
    expect(h.notifier.ofType('auth.prompt')[2]!.promptId).not.toBe(promptId);
    await rt.shutdown();
  });

  it('records attached/detached with the client address and user agent (session_events)', async () => {
    const h = harness();
    const rt = h.runtime();
    const client = { ip: '203.0.113.7', userAgent: 'Firefox' };
    rt.attach(new FakeAttachment('a1'), { cols: 80, rows: 24 }, client);
    rt.detach('a1', client);
    const event = { sessionId: SID, attachmentId: 'a1', actorUserId: 'user-1', ...client };
    expect(h.store.events.filter((e) => e.attachmentId)).toEqual([
      { type: 'attached', ...event },
      { type: 'detached', ...event },
    ]);
    await rt.shutdown();
  });

  it('ends on shell exit, on connection loss without auto-reopen, and on terminate', async () => {
    const exited = harness();
    const rt1 = exited.runtime();
    await rt1.start();
    exited.factory.last.pty.finish({ code: 0, signal: null });
    await until(() => rt1.state === 'ended');
    expect(exited.store.records.get(SID)).toMatchObject({
      desiredState: 'terminated',
      endReason: 'shell_exited',
      status: 'ended',
    });

    const noReopen = harness({ record: { policies: { ...harnessPolicies(), autoReopen: false } } });
    const rt2 = noReopen.runtime();
    await rt2.start();
    noReopen.factory.last.lose();
    await until(() => rt2.state === 'ended');
    expect(noReopen.store.records.get(SID)?.endReason).toBe('connection_lost');

    const terminated = harness();
    const rt3 = terminated.runtime();
    await rt3.start();
    await rt3.terminate();
    expect(terminated.store.transitions(SID).slice(-2)).toEqual([
      ['terminating', 'ended'],
      ['ended', 'ended'],
    ]);
    expect(terminated.store.records.get(SID)).toMatchObject({
      desiredState: 'terminated',
      endReason: 'user_terminated',
    });
    expect(terminated.factory.last.pty.ended).toBe(true);
    expect(terminated.factory.last.closed).toBe(true);
  });

  it('a session whose server was deleted never connects: parked as failed NOT_FOUND, no loop (D-29)', async () => {
    const h = harness({ record: { serverId: null } });
    const rt = h.runtime();
    await rt.start();
    expect(rt.state).toBe('failed');
    expect(rt.live()).toMatchObject({ status: 'disconnected', statusDetail: 'NOT_FOUND' });
    expect(h.factory.created).toHaveLength(0); // no transport, so no login on the host
    expect(h.store.transitions(SID)).toEqual([['failed', 'disconnected']]);
    expect(h.store.events.filter((e) => e.type === 'server_deleted')).toHaveLength(1);
    // Parked, not ended: only terminating it is left (the registry refuses Retry first).
    expect(h.store.records.get(SID)?.desiredState).toBe('running');
    // A retry reaching the runtime anyway parks it again. (Let the parked loop wind down
    // first: start() resolves before the loop has finished.)
    await new Promise((resolve) => setTimeout(resolve, 10));
    await rt.retry();
    await until(() => h.store.events.filter((e) => e.type === 'server_deleted').length === 2);
    expect(h.factory.created).toHaveLength(0);
    await rt.terminate();
    expect(h.store.records.get(SID)).toMatchObject({
      state: 'ended',
      endReason: 'user_terminated',
    });
  });

  it('a server deleted while its session runs: the next connect attempt is refused', async () => {
    const h = harness();
    const rt = h.runtime();
    await rt.start();
    expect(rt.state).toBe('ready');
    // The FK sets server_id NULL; the runtime reads it again before every attempt.
    h.store.records.get(SID)!.serverId = null;
    h.factory.last.lose();
    await until(() => rt.state === 'reconnecting');
    await rt.retry(); // skips the backoff wait
    await until(() => rt.state === 'failed');
    expect(rt.live().statusDetail).toBe('NOT_FOUND');
    expect(h.factory.created).toHaveLength(1);
    expect(h.store.events.map((e) => e.type)).toContain('server_deleted');
    await rt.shutdown();
  });
});

describe('SessionRuntime integration with the drivers', () => {
  const protectedRecord = {
    protection: 'tmux-control' as const,
    remoteIdentity: { sessionCreated: 1, panePid: 10 },
    lastReadyAt: 1,
  };

  it('tmux-control remote reboot: no banner in the mirrored screen; event + ready status detail', async () => {
    const h = harness({
      record: protectedRecord,
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: fakeTmuxDrivers(async (ctx, opts) => {
        expect(opts.previousIdentity).toEqual(protectedRecord.remoteIdentity);
        opts.onIdentity({ sessionCreated: 2, panePid: 20 }, true);
        await ctx.replaceState((fresh) => fresh.write(encode('td@host:~$ ')));
      }),
    });
    const rt = h.runtime();
    await rt.start();
    expect(rt.state).toBe('ready');
    await rt.emulator.flush();
    expect(screenText(rt).trim()).toBe('td@host:~$');
    expect(h.store.events.map((e) => e.type)).toContain('remote_rebooted');
    expect(h.notifier.ofType('session.status').at(-1)).toEqual({
      type: 'session.status',
      sessionId: SID,
      status: 'connected',
      state: 'ready',
      detail: 'remote_rebooted',
    });
    expect(h.store.records.get(SID)?.remoteIdentity).toEqual({ sessionCreated: 2, panePid: 20 });
    await rt.shutdown();
  });

  it('start() rejecting after a confirmed shell exit has one outcome: ended (shell_exited)', async () => {
    const h = harness({
      record: protectedRecord,
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: fakeTmuxDrivers(async (ctx) => {
        ctx.onShellExit({ code: null }); // has-session: the session is gone
        throw new Error('tmux control client exited');
      }),
    });
    const rt = h.runtime();
    await rt.start();
    await until(() => rt.state === 'ended');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.store.records.get(SID)).toMatchObject({ endReason: 'shell_exited', state: 'ended' });
    expect(h.factory.created).toHaveLength(1); // no retry
    expect(h.store.transitions(SID).map(([state]) => state)).not.toContain('reconnecting');
    expect(h.store.events.filter((e) => e.type === 'state_changed').at(-1)?.detail).toMatchObject({
      to: 'ended',
      detail: 'shell_exited',
    });
  });

  it('raw mode types the startup command once into every new shell', async () => {
    const h = harness({
      record: { policies: { ...harnessPolicies(), startupCommand: 'cd /srv' } },
    });
    const rt = h.runtime();
    await rt.start();
    expect(h.factory.last.pty.writtenText).toBe('cd /srv\r');
    h.factory.last.lose(); // auto-reopen: a new shell gets it too
    await until(() => rt.state === 'reconnecting');
    await rt.retry();
    await until(() => rt.state === 'ready');
    expect(h.factory.created.map((t) => t.pty.writtenText)).toEqual(['cd /srv\r', 'cd /srv\r']);
    await rt.shutdown();
  });
});

function harnessPolicies() {
  return {
    protectionMode: 'auto' as const,
    startupCommand: null,
    env: {},
    keepaliveIntervalS: 15,
    autoReopen: true,
  };
}
