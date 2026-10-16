import { AUTH_PROMPT_LIMITS, ServerMessage } from '@termdock/protocol';
import { ErrorCode, TermdockError } from '@termdock/shared';
import { describe, expect, it } from 'vitest';
import { createDriverFactory } from '../../src/core/driver-factory.ts';
import { sanitizePromptText, sanitizeTitle } from '../../src/core/session-runtime.ts';
import { BadLaunchParamsError } from '../../src/core/types.ts';
import { TmuxControlDriver } from '../../src/drivers/tmux-control/index.ts';
import { PROBE_VALUE_MAX_LENGTH } from '../../src/probe/index.ts';
import { fakeTmuxDrivers, harness, TEST_KEY, TMUX_PROBE, until } from './fakes.ts';

const SID = 'session-1';
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const realTmux = () => createDriverFactory((opts) => new TmuxControlDriver(opts));

describe('launch parameters the builders refuse (M1)', () => {
  it('a profile env value with a line break fails the session once: BAD_LAUNCH_PARAMS, no retry', async () => {
    const h = harness({
      record: {
        policies: {
          protectionMode: 'auto',
          startupCommand: null,
          env: { TD_X: 'line1\nline2' },
          keepaliveIntervalS: 15,
          autoReopen: true,
        },
      },
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: realTmux(),
    });
    const rt = h.runtime();
    await rt.start();
    await settle();
    expect(rt.state).toBe('failed');
    expect(rt.live()).toMatchObject({ status: 'disconnected', statusDetail: 'BAD_LAUNCH_PARAMS' });
    expect(h.factory.created).toHaveLength(1); // one login, no reconnect loop
    expect(h.factory.last.closed).toBe(true);
    expect(h.store.transitions(SID).map(([state]) => state)).not.toContain('reconnecting');
    expect(h.store.records.get(SID)?.desiredState).toBe('running'); // waits for Retry
    // The reason survives a reload or a restart (stored with the failed transition).
    const [summary] = await h.store.listForUser('user-1');
    expect(summary?.statusDetail).toBe('BAD_LAUNCH_PARAMS');
    await rt.shutdown();
  });

  it('a probe-returned tmux path outside the safe words fails the same way', async () => {
    const h = harness({
      behavior: () => ({
        probe: TMUX_PROBE.replace('tmux_path=/usr/bin/tmux', 'tmux_path=/usr/bin/tmux;reboot'),
      }),
      drivers: realTmux(),
    });
    const rt = h.runtime();
    await rt.start();
    await settle();
    expect(rt.state).toBe('failed');
    expect(h.notifier.ofType('session.status').at(-1)?.detail).toBe(ErrorCode.BadLaunchParams);
    expect(h.factory.created).toHaveLength(1);
    await rt.shutdown();
  });

  it('only BadLaunchParamsError parks: other start failures still retry', async () => {
    let starts = 0;
    const h = harness({
      behavior: () => ({ probe: TMUX_PROBE }),
      drivers: fakeTmuxDrivers(async () => {
        starts++;
        if (starts === 1) throw new RangeError('a line longer than tmux can produce');
        throw new BadLaunchParamsError('shQuote: value must be a single line without NUL');
      }),
    });
    const rt = h.runtime();
    await rt.start();
    await until(() => rt.state === 'reconnecting');
    await rt.retry();
    await until(() => rt.state === 'failed');
    expect(starts).toBe(2);
    expect(rt.live().statusDetail).toBe('BAD_LAUNCH_PARAMS');
    await rt.shutdown();
  });
});

describe('revoked host keys and refused targets fail closed', () => {
  it('a revoked key presented again: mismatch path, its own event, prompt flagged revoked (M2)', async () => {
    const presented = { type: TEST_KEY.type, fingerprint: TEST_KEY.fingerprint };
    const h = harness({
      behavior: () => ({
        connect: async (hooks) => {
          hooks.onHostKey({ ...TEST_KEY }, 'revoked');
          throw new TermdockError(ErrorCode.HostKeyMismatch, 'revoked', {
            presented,
            revoked: true,
          });
        },
      }),
    });
    const rt = h.runtime();
    await rt.start();
    await settle();
    expect(rt.state).toBe('failed');
    expect(h.factory.created).toHaveLength(1);
    expect(h.hostKeys.pending).toEqual([]); // never offered as a first-use key
    const prompt = {
      type: 'hostkey.prompt',
      sessionId: SID,
      keyType: TEST_KEY.type,
      fingerprint: TEST_KEY.fingerprint,
      mismatch: true,
      revoked: true,
    };
    expect(h.notifier.ofType('hostkey.prompt')).toEqual([prompt]);
    expect(rt.pendingPrompt()).toEqual(prompt);
    expect(h.store.events.map((e) => e.type)).toContain('host_key_revoked_presented');
    expect(h.store.events.map((e) => e.type)).not.toContain('host_key_mismatch');
    // No in-flow accept: the decision is refused outside awaiting_host_key.
    expect(await rt.hostKeyDecision(TEST_KEY.fingerprint, true, 'user-1')).toBe(false);
    expect(h.hostKeys.trustedKeys.size).toBe(0);
    await rt.shutdown();
  });

  it('TARGET_NOT_ALLOWED parks without retrying (L4)', async () => {
    const h = harness({
      behavior: () => ({
        connect: async () => {
          throw new TermdockError(ErrorCode.TargetNotAllowed, 'SSH target 127.0.0.1 refused');
        },
      }),
    });
    const rt = h.runtime();
    await rt.start();
    await settle();
    expect(rt.state).toBe('failed');
    expect(rt.live().statusDetail).toBe('TARGET_NOT_ALLOWED');
    expect(h.factory.created).toHaveLength(1);
    await rt.shutdown();
  });
});

describe('capability probe output (M3)', () => {
  it('more than 64 KiB of probe output fails the attempt like a timeout (retry)', async () => {
    const flood = `${TMUX_PROBE}${'x'.repeat(65 * 1024)}\n`;
    const h = harness({ behavior: (attempt) => ({ probe: attempt === 0 ? flood : TMUX_PROBE }) });
    const rt = h.runtime();
    await rt.start();
    await until(() => rt.state === 'reconnecting');
    expect(h.store.updates.some((u) => 'probe' in u.patch)).toBe(false);
    await rt.retry();
    await until(() => rt.state === 'ready');
    await rt.shutdown();
  });

  it('stores probe values cut to 256 characters', async () => {
    const long = `/bin/${'b'.repeat(400)}`;
    const h = harness({ behavior: () => ({ probe: `shell=${long}\nutf8_locale=C.UTF-8\n` }) });
    const rt = h.runtime();
    await rt.start();
    const stored = h.store.updates.find((u) => 'probe' in u.patch)?.patch.probe;
    expect(stored?.shell).toBe(long.slice(0, PROBE_VALUE_MAX_LENGTH));
    await rt.shutdown();
  });
});

describe('keyboard-interactive prompt text (L2)', () => {
  it('is capped and stripped of controls and invisible formatting before it is sent', async () => {
    const h = harness({
      behavior: () => ({
        connect: async (hooks) => {
          hooks.onHostKey({ ...TEST_KEY }, 'trusted');
          await hooks.onKeyboardInteractive({
            name: `Termdock\u202e\u200b login ${'n'.repeat(400)}`,
            instructions: `Line 1\x1b[31m\r\nLine 2\u2066\u0085 ${'i'.repeat(3000)}`,
            prompts: [{ text: `OTP\u200f:\x07 ${'p'.repeat(400)}`, echo: false }],
          });
        },
      }),
    });
    const rt = h.runtime({ promptTimeoutMs: 1_000 });
    void rt.start();
    await until(() => h.notifier.ofType('auth.prompt').length === 1);
    const prompt = h.notifier.ofType('auth.prompt')[0]!;
    expect(prompt.name.startsWith('Termdock login nnn')).toBe(true);
    expect(prompt.name).toHaveLength(AUTH_PROMPT_LIMITS.name);
    expect(prompt.instructions.startsWith('Line 1[31m\nLine 2 iii')).toBe(true);
    expect(prompt.instructions).toHaveLength(AUTH_PROMPT_LIMITS.instructions);
    expect(prompt.prompts[0]!.text.startsWith('OTP: ppp')).toBe(true);
    expect(prompt.prompts[0]!.text).toHaveLength(AUTH_PROMPT_LIMITS.text);
    // What the daemon sends always fits the protocol schema the browser parses.
    expect(ServerMessage.safeParse(prompt).success).toBe(true);
    await rt.shutdown();
  });

  it('refuses a round with more prompts than the protocol carries', async () => {
    let refused: unknown = null;
    const h = harness({
      behavior: () => ({
        connect: async (hooks) => {
          hooks.onHostKey({ ...TEST_KEY }, 'trusted');
          const prompts = Array.from({ length: AUTH_PROMPT_LIMITS.prompts + 1 }, (_, i) => ({
            text: `Q${i}: `,
            echo: true,
          }));
          refused = await hooks.onKeyboardInteractive({ name: '', instructions: '', prompts }).then(
            () => null,
            (err: Error) => err,
          );
          throw new TermdockError(ErrorCode.AuthRejected, 'refused');
        },
      }),
    });
    const rt = h.runtime();
    await rt.start();
    expect(refused).toBeInstanceOf(Error);
    expect(h.notifier.ofType('auth.prompt')).toEqual([]);
    expect(rt.state).toBe('failed');
    await rt.shutdown();
  });

  it('sanitizePromptText keeps line feeds only in multi-line text and never splits a character', () => {
    expect(sanitizePromptText('a\nb\tc\u202ed', 10, true)).toBe('a\nbcd');
    expect(sanitizePromptText('a\nb', 10, false)).toBe('ab');
    expect(sanitizePromptText('ab😀', 3, false)).toBe('ab');
  });
});

describe('terminal titles (L9)', () => {
  it('drop bidi overrides, isolates, zero-width characters and the BOM', () => {
    const title = 'ls \u202eexe.txt\u202c \u2066x\u2069\u200b\u200c\u200d\u200e\u200f\ufeffend\x1b';
    expect(sanitizeTitle(title)).toBe('ls exe.txt xend');
    expect(sanitizeTitle('é中😀')).toBe('é中😀');
    expect(sanitizeTitle('t'.repeat(300))).toHaveLength(256);
  });
});
