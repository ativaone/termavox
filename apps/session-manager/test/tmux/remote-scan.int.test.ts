// T1: the remote leftover scan (plan D-30) on real tmux (TD_TMUX_IMAGES to override): the three
// format variables, `main` or else the first session, a server that does not answer, a name
// that could break the line format, and that a scan never removes a socket file.
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { randomToken } from '@termdock/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRemoteScan } from '../../src/core/remote-sessions.ts';
import type { ExecChannel } from '../../src/core/types.ts';
import { remoteCommand, scanSocketsCommand } from '../../src/drivers/tmux-control/commands.ts';
import { requireSshd } from '../ssh/sshd.ts';
import {
  execBytes,
  killServerQuietly,
  selectedImages,
  sleep,
  type TmuxEnv,
  tmuxEnv,
  tmuxExec,
} from './driver-harness.ts';

const IMAGES = selectedImages(['tmux-3.2a', 'tmux-3.4', 'tmux-edge']);

describe.each(IMAGES)('remote leftover scan on %s (plan D-30)', (image) => {
  let env: TmuxEnv;
  // A prefix of this run only (1–8 of [a-z0-9]), so other tests' servers never interfere.
  const prefix = `s${randomToken(7)}`;
  const withMain = `td-${prefix}-${randomToken(12)}`;
  const withoutMain = `td-${prefix}-${randomToken(12)}`;
  const dead = `td-${prefix}-${randomToken(12)}`;
  const spaced = `td-${prefix} x`;
  const controls: ExecChannel[] = [];
  const startedAt = Date.now();

  /** A control client attached to `session` of `socket`, kept until the end. */
  const attachControl = async (socket: string, session: string): Promise<void> => {
    const channel = await env.transport.exec(
      remoteCommand(`exec ${env.probe.tmuxPath} -L ${socket} -C attach-session -t ${session}`),
    );
    void (async () => {
      for await (const _chunk of channel.stdout) {
        // drained
      }
    })();
    controls.push(channel);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const out = await tmuxExec(env, socket, `list-clients -t ${session} -F '#{client_pid}'`);
      if (out.stdout.trim() !== '') return;
      await sleep(100);
    }
    throw new Error(`control client on ${socket}:${session} not attached`);
  };

  /** The remote shell expression of this user's tmux socket directory. */
  const socketDir = `"\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"`;

  beforeAll(async () => {
    await requireSshd([image]);
    env = await tmuxEnv(image);
    // `aaa` sorts before `main`: the scan must still report `main` (the one with a client).
    for (const args of ['new-session -d -s aaa', 'new-session -d -s main']) {
      expect((await tmuxExec(env, withMain, args)).code).toBe(0);
    }
    await attachControl(withMain, 'main');
    // No `main`: the first session (`beta`) is reported, not `zeta` (the one with a client).
    for (const args of ['new-session -d -s beta', 'new-session -d -s zeta']) {
      expect((await tmuxExec(env, withoutMain, args)).code).toBe(0);
    }
    await attachControl(withoutMain, 'zeta');
    // A server killed with SIGKILL leaves its socket file behind: nothing answers there.
    expect((await tmuxExec(env, dead, 'new-session -d -s main')).code).toBe(0);
    const killed = await execBytes(
      env.transport,
      remoteCommand(
        `p=$(${env.probe.tmuxPath} -L ${dead} display-message -p '#{pid}'); kill -9 $p; sleep 0.3; test -S ${socketDir}/${dead}`,
      ),
    );
    expect(killed.code).toBe(0);
    // A name with a space would split a scan line: the script skips it.
    const odd = await execBytes(
      env.transport,
      remoteCommand(`exec ${env.probe.tmuxPath} -L '${spaced}' new-session -d -s main`),
    );
    expect(odd.code).toBe(0);
  });

  afterAll(async () => {
    for (const channel of controls) channel.end();
    if (env) {
      for (const socket of [withMain, withoutMain, dead]) await killServerQuietly(env, socket);
      await execBytes(
        env.transport,
        remoteCommand(
          `${env.probe.tmuxPath} -L '${spaced}' kill-server 2>/dev/null; rm -f ${socketDir}/'${spaced}'; true`,
        ),
      ).catch(() => {});
      await env.transport.close();
    }
  });

  it('reports each answering td-* server once, with numbers from the main or first session', async () => {
    const scan = await runRemoteScan(env.transport, env.probe.tmuxPath!);
    const mine = scan.entries.filter((e) => e.socket.startsWith(`td-${prefix}-`));
    expect(mine.map((e) => e.socket).sort()).toEqual([withMain, withoutMain].sort());
    const now = Date.now();
    for (const entry of mine) {
      // session_created and session_activity: epoch seconds of this run, in ms.
      expect(entry.createdAt).toBeGreaterThanOrEqual(Math.floor(startedAt / 1000) * 1000 - 5_000);
      expect(entry.createdAt).toBeLessThanOrEqual(now + 1_000);
      expect(entry.lastActivityAt).toBeGreaterThanOrEqual(entry.createdAt! - 1_000);
      expect(entry.lastActivityAt).toBeLessThanOrEqual(now + 1_000);
    }
    // session_attached: `main` (1 client) over `aaa`; `beta` (no client) over `zeta`.
    expect(mine.find((e) => e.socket === withMain)?.attachedClients).toBe(1);
    expect(mine.find((e) => e.socket === withoutMain)?.attachedClients).toBe(0);
  });

  it('skips the odd name in the script itself and never removes a socket file', async () => {
    const raw = await execBytes(
      env.transport,
      scanSocketsCommand({ tmuxPath: env.probe.tmuxPath! }),
    );
    expect(raw.code).toBe(0);
    const lines = Buffer.from(raw.stdout).toString('utf8').split('\n');
    expect(lines.some((l) => l.startsWith(spaced))).toBe(false);
    expect(lines.some((l) => l.startsWith(dead))).toBe(false);
    for (const l of lines.filter((l) => l.startsWith(`td-${prefix}-`))) {
      expect(l.split('\t')).toHaveLength(4);
    }
    const files = await execBytes(
      env.transport,
      remoteCommand(`test -S ${socketDir}/${dead} && test -S ${socketDir}/'${spaced}'`),
    );
    expect(files.code).toBe(0);
  });
});
