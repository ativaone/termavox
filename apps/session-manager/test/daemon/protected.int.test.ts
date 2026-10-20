// T1: Phase 3 exit criteria through the real daemon (SQLite stores, vault, internal API, WS with
// tickets) on the core tmux images (TV_TMUX_IMAGES to override, e.g. tmux-3.4). The daemon
// reaches sshd through a local TCP proxy, so a test can drop its SSH connection (network drop)
// or abandon it while sshd keeps its side open (daemon death the remote does not notice).
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmuxSocketName } from '../../src/core/driver-factory.ts';
import type { HeadlessEmulator } from '../../src/emulator/headless-emulator.ts';
import type { Daemon } from '../../src/main.ts';
import { until } from '../runtime/fakes.ts';
import { HOST_KEY, requireSshd, TEST_USER, USER_KEY } from '../ssh/sshd.ts';
import { insertAuthSession, insertServer, insertUser } from '../store/fixture.ts';
import { compareEmulators, unknownModesFor } from '../tmux/compare.ts';
import {
  killServerQuietly,
  selectedImages,
  TcpProxy,
  type TmuxEnv,
  tmuxEnv,
  tmuxExec,
} from '../tmux/driver-harness.ts';
import type { TestClient } from '../ws/client.ts';
import { DaemonFixture, screenRows, settled, shows, statusAfter, VIEWPORT } from './harness.ts';

const IMAGES = selectedImages(['tmux-3.2a', 'tmux-edge']);
const PROMPT = /\$ ?$/m;

/**
 * A full-screen (alternate screen) program of the image, and how to leave it. No program is in
 * every image: Ubuntu has ncurses `watch` (busybox `watch` and `top` just clear the main screen,
 * which tmux 3.2 pushes into history, ADR-0003 quirk 4), Alpine has busybox `vi`.
 */
function fullScreenProgram(image: string): { run: string; shows: RegExp; quit: string[] } {
  return image === 'tmux-edge'
    ? // ESC alone first: vi would read ESC + ':' arriving together as one escape sequence.
      { run: 'vi /etc/hosts', shows: /localhost/, quit: ['\x1b', ':q!\r'] }
    : {
        run: "watch -t -n 3600 'echo full-screen-$((6*7))'",
        shows: /full-screen-42/,
        quit: ['\x03'],
      };
}

describe.each(IMAGES)('protected session through the daemon (%s)', (image) => {
  let fixture: DaemonFixture;
  let env: TmuxEnv;
  let proxy: TcpProxy;
  let daemon: Daemon;
  let userId: string;
  let asid: string;
  let sessionId: string;
  let socket = '';
  let client: TestClient;
  const program = fullScreenProgram(image);
  /** The live client's terminal (full-screen program running) before the first restart. */
  let reference: HeadlessEmulator;

  /** Cell, cursor, mode and scrollback differences, minus ADR-0003's unrecoverable state. */
  const differences = (restored: HeadlessEmulator): string[] =>
    compareEmulators(reference, restored, unknownModesFor(env.probe.tmuxVersion!)).diffs;
  /** Visible rows; trailing blanks trimmed (a rebuild reports erased cells, ADR-0003). */
  const rows = (emulator: HeadlessEmulator): string[] =>
    screenRows(emulator).map((row) => row.trimEnd());

  /** Control-mode clients attached to our tmux server: `<control_mode> <pid>` lines. */
  const clients = async (): Promise<string[]> => {
    const out = await tmuxExec(
      env,
      socket,
      "list-clients -F '#{client_control_mode} #{client_pid}'",
    );
    return out.stdout.split('\n').filter(Boolean);
  };
  const restart = async (): Promise<void> => {
    daemon = await fixture.boot();
    await daemon.restored;
    await until(() => daemon.plane.registry.host(sessionId)?.state === 'ready', 20_000);
    client = await fixture.attach(daemon, userId, asid, sessionId);
  };

  beforeAll(async () => {
    await requireSshd([image]);
    env = await tmuxEnv(image);
    proxy = await TcpProxy.start(image);
    fixture = new DaemonFixture();
  });

  afterAll(async () => {
    await fixture?.cleanup();
    if (socket) await killServerQuietly(env, socket);
    await proxy?.close();
    await env?.transport.close();
  });

  it('A. graceful restart: restored automatically, the new client shows the same full-screen program', async () => {
    daemon = await fixture.boot();
    const { db } = daemon;
    userId = insertUser(db);
    const { credentialId } = await daemon.credentials.create({
      actingUserId: userId,
      kind: 'private_key',
      name: 'test key',
      privateKey: USER_KEY,
    });
    const serverId = insertServer(db, userId, {
      name: image,
      port: proxy.port,
      username: TEST_USER,
      credentialId,
    });
    // Pre-trust by pasting the fingerprint: the row has no public key until the first handshake.
    const pasted = await fixture.api(daemon, 'POST', `/servers/${serverId}/trust-key`, {
      actingUserId: userId,
      keyType: HOST_KEY.type,
      fingerprint: HOST_KEY.fingerprint.slice('SHA256:'.length),
    });
    expect(pasted.status).toBe(204);
    asid = insertAuthSession(db, userId, Date.now() + 3_600_000);
    const created = await fixture.api(daemon, 'POST', '/sessions', {
      actingUserId: userId,
      serverId,
      viewport: VIEWPORT,
    });
    expect(created.status).toBe(201);
    sessionId = created.json?.sessionId as string;
    await until(() => daemon.plane.registry.host(sessionId)?.state === 'ready', 20_000);
    expect(daemon.plane.registry.host(sessionId)?.protection).toBe('tmux-control');
    await daemon.writer.flush();
    const address = { userId, hostname: '127.0.0.1', port: proxy.port };
    expect((await daemon.hostKeys.list(address))[0]).toMatchObject({
      status: 'trusted',
      publicKeyB64: HOST_KEY.publicKeyB64, // learned from the matching handshake
    });
    const { tmux_token: token } = db.$client
      .prepare('SELECT tmux_token FROM sessions WHERE id = ?')
      .get(sessionId) as { tmux_token: string };
    socket = tmuxSocketName(daemon.installationId, token);

    client = await fixture.attach(daemon, userId, asid, sessionId);
    await shows(client, PROMPT);
    client.input(1, `seq 1 5000; ${program.run}\r`);
    await shows(client, program.shows);
    reference = await settled(client, 600);
    expect(reference.terminal.buffer.active.type).toBe('alternate');

    await daemon.shutdown();
    expect(client.messages.some((m) => m.type === 'server.shutting_down')).toBe(true);
    // Phase 4 E: no Termavox control client is left and the tmux session lives on.
    expect(await clients()).toEqual([]);
    expect((await tmuxExec(env, socket, 'has-session -t main')).code).toBe(0);

    await restart();
    expect(differences(await settled(client))).toEqual([]);
  });

  it('A. abrupt stop (no detach reaches the remote): the next daemon detaches the stale client and restores', async () => {
    proxy.abandonAll(); // our sockets vanish; sshd keeps the session and its control client
    await daemon.shutdown();
    const stale = await clients();
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/^1 /);

    await restart();
    const now = await clients();
    expect(now).toHaveLength(1); // ours only: the stale client was detached
    expect(now[0]).toMatch(/^1 /);
    expect(now[0]).not.toBe(stale[0]);
    expect(differences(await settled(client))).toEqual([]);

    // Leaving the program: the scrollback holds the seq output.
    for (const keys of program.quit) {
      client.input(1, keys);
      await settled(client, 300);
    }
    const text = await shows(client, PROMPT);
    expect(client.terminal(1).emulator?.terminal.buffer.active.type).toBe('normal');
    expect(text).toMatch(/\n1\n2\n3\n/);
    expect(text).toContain('\n5000\n');
  });

  it('B. network drop: Reconnecting… → Connected, the same screen, no tmux UI (Ctrl-B reaches cat -v)', async () => {
    const before = rows(await settled(client));
    const terminal = client.terminal(1);
    const snapshots = terminal.snapshots.length;
    const mark = client.messages.length;
    proxy.dropAll();
    await statusAfter(client, mark, sessionId, 'reconnecting');
    await statusAfter(client, mark, sessionId, 'connected');
    await until(() => terminal.snapshots.length > snapshots, 10_000); // rebuilt and resynced
    expect(rows(await settled(client))).toEqual(before);

    client.input(1, 'cat -v\r');
    await settled(client, 300);
    client.input(1, '\x02\r');
    const shown = await shows(client, /^\^B$/m);
    expect(shown).not.toContain('[main]'); // no tmux status line
    client.input(1, '\x04');
    await settled(client, 300);
  });

  it("D. the user's own tmux starts inside the session without the nesting warning", async () => {
    // The inner tmux lives long enough to read the replies to its own terminal queries (tmux 3.8
    // asks for OSC 10/11 colours); replies arriving after it exited would be typed into the shell.
    client.input(
      1,
      `printf '[%s]\\n' "\${TMUX-unset}"; tmux new-session -s inner 'sleep 0.5'; echo "inner-rc=$?"\r`,
    );
    const text = await shows(client, /inner-rc=\d/);
    expect(text).toContain('[unset]');
    expect(text).toContain('inner-rc=0');
    expect(text).not.toContain('nested with care');
  });

  it('E. exit in the shell: ended (shell_exited), no tmux server left on the socket', async () => {
    const mark = client.messages.length;
    client.input(1, 'exit\r');
    expect(await statusAfter(client, mark, sessionId, 'ended')).toMatchObject({
      state: 'ended',
      detail: 'shell_exited',
    });
    await daemon.writer.flush();
    expect(
      daemon.db.$client
        .prepare('SELECT desired_state, end_reason FROM sessions WHERE id = ?')
        .get(sessionId),
    ).toEqual({ desired_state: 'terminated', end_reason: 'shell_exited' });
    // `ended` is reported once no tmux process of the socket is left (also a stuck old client).
    const ls = await tmuxExec(env, socket, 'ls');
    expect(ls.code).toBe(1);
    expect(ls.stderr).toMatch(/no server running|error connecting/);
  });
});
