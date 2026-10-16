// T1, spike S5: lifecycle of the protected session (core tmux images; TD_TMUX_IMAGES to
// override). systemd/logind (KillUserProcesses, linger, systemd-run) cannot be exercised: the
// approved images have no systemd (ADR-0003, untested).
// Precondition: docker compose -f test/sshd/compose.yaml up -d --build
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Emulator, RemoteIdentity } from '../../src/core/types.ts';
import {
  launchCommand,
  remoteCommand,
  TmuxControlDriver,
} from '../../src/drivers/tmux-control/index.ts';
import { requireSshd, sshdTransport } from '../ssh/sshd.ts';
import { bufferText, compareEmulators, unknownModesFor } from './compare.ts';
import { TestControlClient } from './control-client.ts';
import {
  BLOCKED_STARTUP,
  DIMS,
  driverOptions,
  execBytes,
  killServerQuietly,
  launchOptions,
  newSocket,
  referenceFromPipe,
  StubRuntime,
  selectedImages,
  sleep,
  startPipe,
  TcpProxy,
  type TmuxEnv,
  tmuxEnv,
  tmuxExec,
  waitUntil,
} from './driver-harness.ts';

const IMAGES = selectedImages(['tmux-3.2a', 'tmux-edge']);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** A full-screen "application": alternate screen, modes, scroll region, then ticks until Enter. */
const ALT_APP =
  "printf '\\033[?1049h\\033[?1h\\033=\\033[?1000h\\033[?1006h\\033[2;12r\\033[H\\033[1mapp\\033[0m'; " +
  "for i in $(seq 1 30); do printf '\\033[%d;3Htick %03d' $(( i % 8 + 3 )) $i; sleep 0.05; done; " +
  "read _; printf '\\033[r\\033[?1006l\\033[?1000l\\033[?1l\\033>\\033[?1049l'";

beforeAll(() => requireSshd(IMAGES));

/** A stub runtime whose replaceState waits for `open()`: start() stays mid-rebuild meanwhile. */
class GatedRuntime extends StubRuntime {
  readonly entered = Promise.withResolvers<void>();
  readonly #gate = Promise.withResolvers<void>();

  open(): void {
    this.#gate.resolve();
  }

  override async replaceState(build: (fresh: Emulator) => void | Promise<void>): Promise<void> {
    this.entered.resolve();
    await this.#gate.promise;
    return super.replaceState(build);
  }
}

describe.each(IMAGES)('S5 lifecycle (%s)', (image) => {
  let env: TmuxEnv;
  const sockets: string[] = [];
  const started = (): string => {
    const socket = newSocket();
    sockets.push(socket);
    return socket;
  };
  const attach = async (
    socket: string,
    overrides: Parameters<typeof driverOptions>[2] = {},
    transport = env.transport,
  ) => {
    const runtime = new StubRuntime(transport);
    const opts = driverOptions(env, socket, overrides);
    const driver = new TmuxControlDriver(opts);
    runtime.driver = driver;
    await driver.start(runtime, DIMS);
    return { runtime, opts, driver };
  };

  beforeAll(async () => {
    env = await tmuxEnv(image);
  });

  afterAll(async () => {
    for (const socket of sockets) await killServerQuietly(env, socket);
    await env.transport.close();
  });

  it('1. daemon death mid-output: a new transport + driver reattach; state and scrollback kept', async () => {
    const socket = started();
    const proxy = await TcpProxy.start(image);
    const doomed = sshdTransport(image, { port: proxy.port });
    await doomed.connect(AbortSignal.timeout(15_000));
    let lost = false;
    doomed.onLost(() => {
      lost = true;
    });
    const first = await attach(socket, { startupCommand: BLOCKED_STARTUP }, doomed);
    const identity = first.opts.identities[0]!.identity as RemoteIdentity;
    expect(first.opts.identities).toEqual([{ identity, rebooted: false }]);
    expect(first.driver.stats.created).toBe(true);
    const rawPath = await startPipe(env, socket);
    first.driver.input(enc('\r'));
    await waitUntil(() => first.runtime.text().includes('$ '), 10_000, 'the prompt');
    first.driver.input(enc(`seq 1 3000; ${ALT_APP}\r`));
    await waitUntil(() => first.runtime.text().includes('tick 010'), 20_000, 'the app');
    proxy.dropAll(); // the daemon dies mid-output
    await waitUntil(() => lost, 10_000, 'the transport loss');

    const transport = sshdTransport(image);
    await transport.connect(AbortSignal.timeout(15_000));
    try {
      const second = await attach(socket, { previousIdentity: identity }, transport);
      expect(second.opts.identities).toEqual([{ identity, rebooted: false }]);
      expect(second.driver.stats.created).toBe(false);
      await waitUntil(() => second.runtime.text().includes('tick 030'), 20_000, 'the last tick');
      await second.runtime.quiet(400);
      const unknown = unknownModesFor(env.probe.tmuxVersion!);
      const inApp = await referenceFromPipe(env, socket, rawPath, { keepOpen: true });
      const appResult = compareEmulators(inApp.emulator, second.runtime.emulator, unknown);
      expect(second.runtime.emulator.terminal.buffer.active.type).toBe('alternate');
      expect(appResult.diffs).toEqual([]);

      second.driver.input(enc('\r')); // quit the app
      await waitUntil(
        () => second.runtime.emulator.terminal.buffer.active.type === 'normal',
        10_000,
        'the normal screen',
      );
      await second.runtime.quiet(400);
      const after = await referenceFromPipe(env, socket, rawPath);
      const result = compareEmulators(after.emulator, second.runtime.emulator, unknown);
      console.log(
        `[S5 ${image}] reattach after drop: identity ${JSON.stringify(identity)}, stale clients ` +
          `detached ${second.driver.stats.staleClientsDetached}, in-app diffs ${appResult.diffs.length}, ` +
          `after-app diffs ${result.diffs.length}, scrollback compared ${result.scrollbackCompared}`,
      );
      expect(result.diffs).toEqual([]);
      const text = bufferText(second.runtime.emulator);
      expect(text).toMatch(/\n1\n2\n3\n/); // scrollback contains the earliest seq lines
      expect(text).toContain('\n3000\n');
      await second.driver.terminate();
    } finally {
      await transport.close();
      await proxy.close();
    }
  });

  it('2. remote reboot (server gone between attaches): rebooted=true, the driver writes no banner', async () => {
    const socket = started();
    const first = await attach(socket);
    const identity = first.opts.identities[0]!.identity as RemoteIdentity;
    await first.driver.detach();
    expect((await tmuxExec(env, socket, 'has-session -t main')).code).toBe(0); // detach kept it
    await tmuxExec(env, socket, 'kill-server');
    const second = await attach(socket, { previousIdentity: identity });
    expect(second.opts.identities).toHaveLength(1);
    expect(second.opts.identities[0]!.rebooted).toBe(true);
    expect(second.opts.identities[0]!.identity).not.toEqual(identity);
    expect(second.driver.stats.created).toBe(true);
    expect(second.runtime.banners).toEqual([]); // the runtime writes it after start()
    await second.driver.terminate();
  });

  it('3. a stale control client is detached; an external detach-client → onDesync', async () => {
    const socket = started();
    const stale = new TestControlClient(
      await env.transport.exec(launchCommand(launchOptions(env, socket, null))),
    );
    await stale.waitFor((e) => e.type === 'sessionChanged');
    const { runtime, driver } = await attach(socket);
    expect(driver.stats.staleClientsDetached).toBe(1);
    expect((await stale.exit).code).toBe(0);
    expect(stale.events.some((e) => e.type === 'exit')).toBe(true);
    const clients = await tmuxExec(env, socket, "list-clients -F '#{client_control_mode}'");
    expect(clients.stdout.trim().split('\n')).toEqual(['1']); // only the driver's client

    // %exit also follows detach-client: has-session says the session lives → reattach.
    await tmuxExec(env, socket, 'detach-client -s main');
    await waitUntil(() => runtime.desyncs.length > 0, 10_000, 'onDesync');
    expect(runtime.shellExits).toEqual([]);
    expect((await tmuxExec(env, socket, 'has-session -t main')).code).toBe(0);
  });

  it('4. exit in the shell → onShellExit (has-session confirms); terminate() leaves no server', async () => {
    const exiting = started();
    const first = await attach(exiting);
    await first.runtime.quiet(300);
    first.driver.input(enc('exit\r'));
    await waitUntil(() => first.runtime.shellExits.length > 0, 10_000, 'onShellExit');
    expect(first.runtime.shellExits).toEqual([{ code: null }]);
    expect(first.runtime.desyncs).toEqual([]);
    expect((await tmuxExec(env, exiting, 'has-session -t main')).code).toBe(1);

    const terminated = started();
    const second = await attach(terminated);
    await second.driver.terminate();
    const ls = await tmuxExec(env, terminated, 'ls');
    expect(ls.code).toBe(1);
    expect(ls.stderr).toMatch(/no server running|error connecting/);
    expect(second.runtime.shellExits).toEqual([]);
    expect(second.runtime.desyncs).toEqual([]);
  });

  it("5. the user's own tmux starts inside the session without the nesting warning", async () => {
    const socket = started();
    const { runtime, driver } = await attach(socket);
    await runtime.quiet(300);
    driver.input(
      enc(
        `printf '[%s]\\n' "\${TMUX-unset}"; tmux new-session -s inner 'exit 0'; echo "inner-rc=$?"\r`,
      ),
    );
    await waitUntil(() => /inner-rc=\d/.test(runtime.text()), 15_000, 'the inner tmux');
    const text = runtime.text();
    expect(text).toContain('[unset]');
    expect(text).toContain('inner-rc=0');
    expect(text).not.toContain('nested with care');
    await driver.terminate();
  });

  it('6. csh-family shell: the startup command is typed into a NEW session only', async () => {
    const socket = started();
    // The login shell is bash in these images: the probe claims tcsh so the driver types the
    // command (tcsh itself rejecting -lc was verified in ADR-0002).
    const overrides = {
      probe: { ...env.probe, shell: '/bin/tcsh' },
      startupCommand: 'echo typed-$((6*7))',
    };
    const first = await attach(socket, overrides);
    expect(first.driver.stats.created).toBe(true);
    await waitUntil(() => first.runtime.text().includes('typed-42'), 10_000, 'the typed command');
    await first.runtime.quiet(300);
    await first.driver.detach();
    const second = await attach(socket, overrides);
    expect(second.driver.stats.created).toBe(false);
    await second.runtime.quiet(500);
    expect(second.runtime.text().match(/^typed-42$/gm)).toHaveLength(1);
    await second.driver.terminate();
  });

  it('7. resize() is confirmed through %layout-change; input leaves copy mode first', async () => {
    const socket = started();
    const { runtime, driver } = await attach(socket);
    driver.resize({ cols: 100, rows: 30 });
    await waitUntil(
      () => runtime.resizes.some((d) => d.cols === 100 && d.rows === 30),
      10_000,
      'ctx.resized(100x30)',
    );
    expect(runtime.emulator.cols).toBe(100);
    await tmuxExec(env, socket, 'copy-mode -t main');
    await sleep(300); // %pane-mode-changed → the driver re-reads pane_in_mode
    driver.input(enc('echo after-$((6*7))\r'));
    await waitUntil(() => runtime.text().includes('after-42'), 10_000, 'input after copy mode');
    const mode = await tmuxExec(env, socket, "display-message -p -t main '#{pane_in_mode}'");
    expect(mode.stdout.trim()).toBe('0');
    await driver.terminate();
  });

  it('8. deleted socket: SIGUSR1 makes tmux recreate it; the reattach is not a reboot', async () => {
    const socket = started();
    const first = await attach(socket);
    const identity = first.opts.identities[0]!.identity as RemoteIdentity;
    await first.driver.detach();
    await execBytes(env.transport, remoteCommand(`rm -f "/tmp/tmux-$(id -u)/${socket}"`));
    expect((await tmuxExec(env, socket, 'has-session -t main')).code).toBe(1); // unreachable
    const second = await attach(socket, { previousIdentity: identity });
    expect(second.opts.identities).toEqual([{ identity, rebooted: false }]);
    expect(second.driver.stats).toMatchObject({ created: false, socketRecoveries: 1 });
    await second.driver.terminate();
    // One server existed throughout: terminate left no tmux process for the socket.
    const left = await execBytes(
      env.transport,
      remoteCommand(
        `s=${socket}; pgrep -u "$(id -u)" -f "^[^ ]*[t]mux[^ ]* .*-L $s " || echo none`,
      ),
    );
    expect(Buffer.from(left.stdout).toString().trim()).toBe('none');
  });

  it('9. control channel closed without %exit: has-session decides (alive → onDesync, gone → onShellExit)', async () => {
    // SIGKILL leaves the control client no chance to print %exit; the server goes after it.
    const kill = (socket: string, server: boolean) =>
      execBytes(
        env.transport,
        remoteCommand(
          `t=${env.probe.tmuxPath}; c=$("$t" -L ${socket} list-clients -F '#{client_pid}'); ` +
            (server
              ? `p=$("$t" -L ${socket} display-message -p -t main '#{pid}'); kill -9 $c; kill -9 $p`
              : 'kill -9 $c'),
        ),
      );
    const alive = started();
    const a = await attach(alive);
    await kill(alive, false);
    await waitUntil(() => a.runtime.desyncs.length > 0, 10_000, 'onDesync');
    expect(a.runtime.desyncs).toEqual(['control channel closed']);
    expect(a.runtime.shellExits).toEqual([]);
    expect((await tmuxExec(env, alive, 'has-session -t main')).code).toBe(0);

    const gone = started();
    const b = await attach(gone);
    await kill(gone, true);
    await waitUntil(() => b.runtime.shellExits.length > 0, 10_000, 'onShellExit');
    expect(b.runtime.shellExits).toEqual([{ code: null }]);
    expect(b.runtime.desyncs).toEqual([]);
  });

  it('10. the session dies during start(): onShellExit (has-session: gone), then start() rejects', async () => {
    const socket = started();
    const runtime = new GatedRuntime(env.transport);
    const driver = new TmuxControlDriver(driverOptions(env, socket));
    runtime.driver = driver;
    const outcome = driver.start(runtime, DIMS).then(
      () => 'resolved',
      () => 'rejected',
    );
    await runtime.entered.promise; // the launch ran; start() is rebuilding
    await tmuxExec(env, socket, 'kill-server');
    await waitUntil(() => runtime.shellExits.length > 0, 10_000, 'onShellExit');
    runtime.open();
    expect(await outcome).toBe('rejected');
    expect(runtime.shellExits).toEqual([{ code: null }]);
    expect(runtime.desyncs).toEqual([]);
  });

  it('11. a control client whose output can never be written does not outlive the session (exit, terminate)', async () => {
    /** tmux processes of the socket (server and clients). */
    const processes = async (socket: string): Promise<string> => {
      const command = `s=${socket}; pgrep -u "$(id -u)" -f "^[^ ]*[t]mux[^ ]* .*-L $s " || true`;
      return Buffer.from((await execBytes(env.transport, remoteCommand(command))).stdout)
        .toString()
        .trim();
    };
    /**
     * A second control client writes into a FIFO; flood output fills it, then its reader goes
     * away with output still queued (a connection that died mid-output). tmux keeps such a
     * client, and its server, forever (3.2a, 3.4 and 3.8).
     */
    const stuckClient = async (socket: string, driver: TmuxControlDriver, runtime: StubRuntime) => {
      const f = `/tmp/${socket}.stuck`;
      const alive = `while [ -e ${f} ]; do sleep 0.2; done`;
      await execBytes(
        env.transport,
        remoteCommand(
          `rm -f ${f}; mkfifo ${f}; (exec 3<>${f}; ${alive}) </dev/null >/dev/null 2>&1 & ` +
            `((${alive}) | ${env.probe.tmuxPath} -L ${socket} -C attach -t main >${f} 2>/dev/null) ` +
            '</dev/null >/dev/null 2>&1 & sleep 0.5',
        ),
      );
      driver.input(enc('yes | head -c 400000; echo flood-$((6*7))\r'));
      await waitUntil(() => /^flood-42$/m.test(runtime.text()), 15_000, 'the flood');
      await execBytes(env.transport, remoteCommand(`rm -f ${f}; sleep 0.5`)); // reader gone
    };

    const exiting = started();
    const a = await attach(exiting);
    await stuckClient(exiting, a.driver, a.runtime);
    a.driver.input(enc('exit\r'));
    await waitUntil(() => a.runtime.shellExits.length > 0, 15_000, 'onShellExit');
    expect(a.runtime.desyncs).toEqual([]);
    expect(await processes(exiting)).toBe(''); // reported only once nothing is left

    const terminated = started();
    const b = await attach(terminated);
    await stuckClient(terminated, b.driver, b.runtime);
    await b.driver.terminate();
    expect(await processes(terminated)).toBe('');
  });
});
