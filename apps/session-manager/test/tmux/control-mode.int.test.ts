// T1: a live tmux control-mode session over SshTransport (core tmux images).
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { randomToken } from '@termavox/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hasSessionCommand,
  type LaunchOptions,
  launchCommand,
  refreshClientSize,
  singlePaneLayout,
} from '../../src/drivers/tmux-control/index.ts';
import { parseProbeOutput, probeCommand } from '../../src/probe/index.ts';
import type { SshTransport } from '../../src/transport/ssh/index.ts';
import { requireSshd, runExec, type SshdImage, sshdTransport } from '../ssh/sshd.ts';
import { TestControlClient } from './control-client.ts';

const IMAGES: SshdImage[] = ['tmux-3.2a', 'tmux-edge'];

beforeAll(() => requireSshd(IMAGES));

describe.each(IMAGES)('tmux control mode (%s)', (image) => {
  let transport: SshTransport;
  let opts: LaunchOptions;

  beforeAll(async () => {
    transport = sshdTransport(image);
    await transport.connect(AbortSignal.timeout(15_000));
    const probe = parseProbeOutput((await runExec(transport, probeCommand())).stdout);
    opts = {
      tmuxPath: probe.tmuxPath!,
      socket: `tv-t1-${randomToken(12)}`,
      locale: probe.utf8Locale!,
      historyLimit: 5000,
      defaultTerminal: probe.tiTmux256 ? 'tmux-256color' : 'screen-256color',
      cols: 80,
      rows: 24,
      env: { TV_T1: "x 'y' z" },
      startupCommand: null,
    };
  });

  afterAll(async () => {
    // Best effort: never leave a tmux server behind on the container.
    await runExec(
      transport,
      `exec sh -c '${opts.tmuxPath} -L ${opts.socket} kill-server 2>/dev/null; true'`,
    ).catch(() => {});
    await transport.close();
  });

  it('launches, echoes input, resizes, answers has-session and exits on kill-server', async () => {
    expect((await runExec(transport, hasSessionCommand(opts))).exit.code).toBe(1);

    const client = new TestControlClient(await transport.exec(launchCommand(opts)));
    await client.waitFor((e) => e.type === 'sessionChanged');
    await client.waitFor((e) => e.type === 'output'); // the shell prompt
    await client.waitIdle(300);

    // Input through the send-keys -H encoder: arithmetic proves the shell ran it, the env var
    // proves -e reached the pane, TMUX proves env -u removed our variables.
    await client.input(0, `echo "R=$((6*7)) [$TV_T1] [\${TMUX:-unset}] é中😀"\r`);
    await expect
      .poll(() => client.outputText(0), { timeout: 5_000 })
      .toContain("R=42 [x 'y' z] [unset] é中😀\r\n");

    const resized = client.next((e) => e.type === 'layoutChange');
    expect((await client.send(refreshClientSize(100, 30))).ok).toBe(true);
    const layout = await resized;
    expect(layout.type === 'layoutChange' && singlePaneLayout(layout.layout)).toEqual({
      width: 100,
      height: 30,
      paneId: 0,
    });
    const size = await client.send("display-message -p '#{pane_width}x#{pane_height}'");
    expect(Buffer.from(size.lines[0]!).toString()).toBe('100x30');

    expect((await runExec(transport, hasSessionCommand(opts))).exit.code).toBe(0);

    const exited = client.next((e) => e.type === 'exit');
    expect((await client.send('kill-server')).ok).toBe(true);
    await exited;
    expect((await client.exit).code).toBe(0);
    expect(client.errors).toEqual([]);
    expect((await runExec(transport, hasSessionCommand(opts))).exit.code).toBe(1);
  });
});

// Every tmux of the matrix (3.2a, 3.4, 3.8): a profile env value ending in `;` (plan §6.3, L8).
const SEMICOLON_IMAGES: SshdImage[] = ['tmux-3.2a', 'tmux-3.4', 'tmux-edge'];

describe.each(SEMICOLON_IMAGES)('env values ending in ; (%s)', (image) => {
  let transport: SshTransport;
  let opts: LaunchOptions;

  beforeAll(async () => {
    await requireSshd([image]);
    transport = sshdTransport(image);
    await transport.connect(AbortSignal.timeout(15_000));
    const probe = parseProbeOutput((await runExec(transport, probeCommand())).stdout);
    opts = {
      tmuxPath: probe.tmuxPath!,
      socket: `tv-t1-${randomToken(12)}`,
      locale: probe.utf8Locale!,
      historyLimit: 5000,
      defaultTerminal: probe.tiTmux256 ? 'tmux-256color' : 'screen-256color',
      cols: 80,
      rows: 24,
      env: { TV_SEMI: 'ends with;', TV_ESC: 'esc\\;', TV_BARE: ';' },
      startupCommand: null,
    };
  });

  afterAll(async () => {
    await runExec(
      transport,
      `exec sh -c '${opts.tmuxPath} -L ${opts.socket} kill-server 2>/dev/null; true'`,
    ).catch(() => {});
    await transport.close();
  });

  it('launches, and the values reach the shell intact', async () => {
    const client = new TestControlClient(await transport.exec(launchCommand(opts)));
    await client.waitFor((e) => e.type === 'sessionChanged');
    await client.waitFor((e) => e.type === 'output'); // the shell prompt
    await client.waitIdle(300);
    await client.input(0, 'echo "V=[$TV_SEMI][$TV_ESC][$TV_BARE]"\r');
    await expect
      .poll(() => client.outputText(0), { timeout: 5_000 })
      .toContain('V=[ends with;][esc\\;][;]\r\n');
    const exited = client.next((e) => e.type === 'exit');
    expect((await client.send('kill-server')).ok).toBe(true);
    await exited;
    expect(client.errors).toEqual([]);
  });
});
