// T1: Home and End in a protected session (core tmux images; TV_TMUX_IMAGES to override). The
// browser's xterm sends them as `CSI H`/`CSI F` or `SS3 H`/`SS3 F`; the pane's terminal
// (tmux-256color or screen-256color) reads `CSI 1 ~`/`CSI 4 ~`, so the driver sends them to tmux
// by name. `cat -v` in the pane shows the bytes a program receives.
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

  it('reach the program as its terminal reads them; Alt+O then F stays two keys', async () => {
    const socket = newSocket();
    sockets.push(socket);
    const runtime = new StubRuntime(env.transport);
    const driver = new TmuxControlDriver(driverOptions(env, socket));
    runtime.driver = driver;
    await driver.start(runtime, DIMS);
    try {
      driver.input(enc('\r'));
      await waitUntil(() => runtime.text().includes('$ '), 10_000, 'the prompt');
      driver.input(enc('cat -v\r'));
      // The driver reports the foreground program a second after Enter: cat is reading.
      await waitUntil(() => runtime.foregrounds.includes('cat'), 10_000, 'cat in the foreground');
      // One input event per key, as the browser sends them: End and Home in both cursor modes.
      for (const key of ['\x1b[F', '\x1bOF', '\x1b[H', '\x1bOH']) driver.input(enc(key));
      driver.input(enc('|'));
      // Alt+O, then F: two events, so two keys (not End).
      driver.input(enc('\x1bO'));
      driver.input(enc('F'));
      driver.input(enc('\r'));
      const expected = '^[[4~^[[4~^[[1~^[[1~|^[OF';
      await waitUntil(() => runtime.text().includes(expected), 10_000, 'the keys from cat -v');
      expect(runtime.text()).not.toContain('^[[F');
      expect(runtime.text()).not.toContain('^[OH');
    } finally {
      driver.input(enc('\x04'));
      await driver.detach();
    }
  });
});
