// T1: Home and End in a protected session (core tmux images; TV_TMUX_IMAGES to override). The
// browser's xterm sends them as `CSI H`/`CSI F` or `SS3 H`/`SS3 F`. With tmux's own terminal type
// (tmux-256color or screen-256color) the pane reads `CSI 1 ~`/`CSI 4 ~`, so the driver sends them
// to tmux by name; with xterm-256color (plan D-49) the pane reads the browser's bytes as they are,
// so they go unchanged. `cat -v` in the pane shows the bytes a program receives. Each case pins
// its terminal type, so TV_TMUX_TERM (driver-harness) does not change what it checks.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TmuxControlDriver } from '../../src/drivers/tmux-control/index.ts';
import { requireSshd } from '../ssh/sshd.ts';
import {
  DIMS,
  driverOptions,
  killServerQuietly,
  newSocket,
  StubRuntime,
  selectedImages,
  type TmuxEnv,
  tmuxEnv,
  waitUntil,
} from './driver-harness.ts';

const IMAGES = selectedImages(['tmux-3.2a', 'tmux-edge']);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

beforeAll(() => requireSshd(IMAGES));

describe.each(IMAGES)('Home and End in a protected session (%s)', (image) => {
  let env: TmuxEnv;
  const sockets: string[] = [];

  beforeAll(async () => {
    env = await tmuxEnv(image);
  });

  afterAll(async () => {
    for (const socket of sockets) await killServerQuietly(env, socket);
    await env.transport.close();
  });

  /**
   * Starts a session of this terminal type, checks the TERM and COLORTERM its shell sees, then
   * runs `cat -v`, sends `keys` one input event each, then Enter, and waits for `expected`.
   */
  async function catKeys(
    tmuxTerm: 'auto' | 'xterm-256color',
    term: string,
    keys: readonly string[],
    expected: string,
  ): Promise<string> {
    const socket = newSocket();
    sockets.push(socket);
    const runtime = new StubRuntime(env.transport);
    const driver = new TmuxControlDriver(driverOptions(env, socket, { tmuxTerm }));
    runtime.driver = driver;
    await driver.start(runtime, DIMS);
    try {
      driver.input(enc('\r'));
      await waitUntil(() => runtime.text().includes('$ '), 10_000, 'the prompt');
      // Protected sessions declare truecolor (the server sets no COLORTERM here).
      driver.input(enc('echo "$TERM $COLORTERM"\r'));
      await waitUntil(
        () => runtime.text().includes(`${term} truecolor`),
        10_000,
        `"${term} truecolor" from the shell`,
      );
      driver.input(enc('cat -v\r'));
      // The driver reports the foreground program a second after Enter: cat is reading.
      await waitUntil(() => runtime.foregrounds.includes('cat'), 10_000, 'cat in the foreground');
      for (const key of keys) driver.input(enc(key));
      driver.input(enc('\r'));
      await waitUntil(() => runtime.text().includes(expected), 10_000, 'the keys from cat -v');
      return runtime.text();
    } finally {
      driver.input(enc('\x04'));
      await driver.detach();
    }
  }

  it("tmux's own type: they reach the program as its terminal reads them; Alt+O then F stays two keys", async () => {
    const term = env.probe.tiTmux256 ? 'tmux-256color' : 'screen-256color';
    // End and Home in both cursor modes, then Alt+O and F: two events, so two keys (not End).
    const keys = ['\x1b[F', '\x1bOF', '\x1b[H', '\x1bOH', '|', '\x1bO', 'F'];
    const text = await catKeys('auto', term, keys, '^[[4~^[[4~^[[1~^[[1~|^[OF');
    expect(text).not.toContain('^[[F');
    expect(text).not.toContain('^[OH');
  });

  it('xterm-256color (D-49): they reach the program exactly as the browser sent them', async () => {
    const keys = ['\x1b[F', '\x1bOF', '\x1b[H', '\x1bOH', '|'];
    const text = await catKeys('xterm-256color', 'xterm-256color', keys, '^[[F^[OF^[[H^[OH|');
    expect(text).not.toContain('^[[4~');
    expect(text).not.toContain('^[[1~');
  });
});
