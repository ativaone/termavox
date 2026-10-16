/**
 * T1 harness for TmuxControlDriver: a stub runtime (DriverContext) that owns a HeadlessEmulator
 * like SessionRuntime does, the reference streams used by the golden comparisons, and a TCP
 * proxy that can drop a connection abruptly.
 */
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import { randomToken } from '@termdock/shared';
import type {
  Dimensions,
  DriverContext,
  Emulator,
  ExecChannel,
  PtyChannel,
  PtyOptions,
  Transport,
  TransportError,
} from '../../src/core/types.ts';
import {
  type LaunchOptions,
  launchCommand,
  parseCapture,
  rebuild,
  remoteCommand,
  snapshotCommands,
  type TmuxControlDriver,
  type TmuxControlDriverOptions,
} from '../../src/drivers/tmux-control/index.ts';
import { HeadlessEmulator } from '../../src/emulator/headless-emulator.ts';
import { type ProbeResult, parseProbeOutput, probeCommand } from '../../src/probe/index.ts';
import type { SshTransport } from '../../src/transport/ssh/index.ts';
import { runExec, SSHD_PORTS, type SshdImage, sshdTransport } from '../ssh/sshd.ts';
import { TestControlClient } from './control-client.ts';

export const DIMS: Dimensions = { cols: 80, rows: 24 };
export const SCROLLBACK = 5_000;
/** Keeps the pane silent until Enter, so a pipe-pane reference can start before its first byte. */
export const BLOCKED_STARTUP = 'read -r _; exec "$SHELL" -l';
const HIGH_WATER = 8 * 1024 * 1024;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(
  check: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out (${timeoutMs} ms) waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * DriverContext stand-in with SessionRuntime's emulator semantics: output → emulator, resized →
 * queued emulator resize, replaceState → fresh emulator filled by the driver then swapped in,
 * and the 8 MiB ingest backpressure (pauseOutput until the emulator caught up).
 */
export class StubRuntime implements DriverContext {
  emulator: HeadlessEmulator;
  readonly transport: Transport;
  readonly banners: string[] = [];
  readonly shellExits: Array<{ code: number | null }> = [];
  readonly desyncs: string[] = [];
  readonly resizes: Dimensions[] = [];
  replaces = 0;
  outputBytes = 0;
  lastOutputAt = Date.now();
  driver: TmuxControlDriver | null = null;
  readonly #scrollback: number;
  #pending = 0;
  #paused = false;
  #held = false;

  /** Stops reading the control channel (as an overloaded runtime would) until release(). */
  hold(): void {
    this.#held = true;
    this.driver?.pauseOutput();
  }

  release(): void {
    this.#held = false;
    if (!this.#paused) this.driver?.resumeOutput();
  }

  constructor(transport: Transport, dims: Dimensions = DIMS, scrollback = SCROLLBACK) {
    this.transport = transport;
    this.#scrollback = scrollback;
    this.emulator = this.#fresh(dims);
  }

  #fresh(dims: Dimensions): HeadlessEmulator {
    return new HeadlessEmulator({ ...dims, scrollback: this.#scrollback, answerQueries: false });
  }

  output(chunk: Uint8Array): void {
    this.outputBytes += chunk.byteLength;
    this.lastOutputAt = Date.now();
    this.emulator.write(chunk);
    this.#pending += chunk.byteLength;
    if (this.#pending > HIGH_WATER && !this.#paused && this.driver) {
      this.#paused = true;
      this.driver.pauseOutput();
      void this.emulator.flush().then(() => {
        this.#pending = 0;
        this.#paused = false;
        if (!this.#held) this.driver?.resumeOutput();
      });
    }
  }

  resized(dims: Dimensions): void {
    this.resizes.push(dims);
    this.emulator.resize(dims);
  }

  async replaceState(build: (fresh: Emulator) => void | Promise<void>): Promise<void> {
    const fresh = this.#fresh({ cols: this.emulator.cols, rows: this.emulator.rows });
    await build(fresh);
    const old = this.emulator;
    this.emulator = fresh;
    old.dispose();
    this.replaces++;
    this.lastOutputAt = Date.now();
  }

  banner(text: string): void {
    this.banners.push(text);
  }

  onShellExit(info: { code: number | null }): void {
    this.shellExits.push(info);
  }

  onDesync(reason: string): void {
    this.desyncs.push(reason);
  }

  /** Resolves once no output arrived for `quietMs` and the emulator parsed everything. */
  async quiet(quietMs = 600, timeoutMs = 30_000): Promise<void> {
    await waitUntil(() => Date.now() - this.lastOutputAt >= quietMs, timeoutMs, 'quiet output');
    await this.emulator.flush();
  }

  text(): string {
    const buffer = this.emulator.terminal.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)!.translateToString(true));
    return lines.join('\n');
  }
}

export interface TmuxEnv {
  image: SshdImage;
  transport: SshTransport;
  probe: ProbeResult;
}

export async function tmuxEnv(
  image: SshdImage,
  transport = sshdTransport(image),
): Promise<TmuxEnv> {
  await transport.connect(AbortSignal.timeout(15_000));
  const probe = parseProbeOutput((await runExec(transport, probeCommand())).stdout);
  if (!probe.tmuxPath || !probe.utf8Locale || !probe.tmuxVersion) {
    throw new Error(`${image}: probe found no tmux / UTF-8 locale`);
  }
  return { image, transport, probe };
}

export const newSocket = (): string => `td-t1-${randomToken(10)}`;

export function driverOptions(
  env: TmuxEnv,
  socket: string,
  overrides: Partial<TmuxControlDriverOptions> = {},
): TmuxControlDriverOptions & { identities: Array<{ identity: unknown; rebooted: boolean }> } {
  const identities: Array<{ identity: unknown; rebooted: boolean }> = [];
  return {
    probe: env.probe,
    socket,
    scrollbackLines: SCROLLBACK,
    startupCommand: null,
    env: {},
    previousIdentity: null,
    onIdentity: (identity, rebooted) => identities.push({ identity, rebooted }),
    ...overrides,
    identities,
  };
}

export function launchOptions(env: TmuxEnv, socket: string, startup: string | null): LaunchOptions {
  return {
    tmuxPath: env.probe.tmuxPath!,
    socket,
    locale: env.probe.utf8Locale!,
    historyLimit: SCROLLBACK,
    defaultTerminal: env.probe.tiTmux256 ? 'tmux-256color' : 'screen-256color',
    cols: DIMS.cols,
    rows: DIMS.rows,
    startupCommand: startup,
  };
}

/** Runs a remote command and returns stdout as bytes. */
export async function execBytes(
  transport: Transport,
  command: string,
): Promise<{ stdout: Uint8Array; stderr: string; code: number | null }> {
  const channel = await transport.exec(command);
  channel.end();
  const out: Uint8Array[] = [];
  const err: Uint8Array[] = [];
  const pump = async (stream: AsyncIterable<Uint8Array>, sink: Uint8Array[]): Promise<void> => {
    for await (const chunk of stream) sink.push(chunk);
  };
  const [, , exit] = await Promise.all([
    pump(channel.stdout, out),
    pump(channel.stderr, err),
    channel.exit,
  ]);
  return {
    stdout: Buffer.concat(out),
    stderr: Buffer.concat(err).toString('utf8'),
    code: exit.code,
  };
}

export async function tmuxExec(
  env: TmuxEnv,
  socket: string,
  args: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const r = await execBytes(
    env.transport,
    remoteCommand(`exec ${env.probe.tmuxPath} -L ${socket} ${args}`),
  );
  return { stdout: Buffer.from(r.stdout).toString('utf8'), stderr: r.stderr, code: r.code };
}

export async function killServerQuietly(env: TmuxEnv, socket: string): Promise<void> {
  await execBytes(
    env.transport,
    remoteCommand(
      `${env.probe.tmuxPath} -L ${socket} kill-server 2>/dev/null; rm -f /tmp/${socket}.raw "/tmp/tmux-$(id -u)/${socket}"; true`,
    ),
  ).catch(() => {});
}

/** Pipes the pane's raw output (every byte tmux reads from the pty) to a remote file. */
export async function startPipe(env: TmuxEnv, socket: string): Promise<string> {
  const rawPath = `/tmp/${socket}.raw`;
  const r = await tmuxExec(env, socket, `pipe-pane -t main -o 'cat > ${rawPath}'`);
  if (r.code !== 0) throw new Error(`pipe-pane failed: ${r.stderr}`);
  return rawPath;
}

/** The live reference: a fresh emulator fed the pane's raw output from its first byte. */
export async function referenceFromPipe(
  env: TmuxEnv,
  socket: string,
  rawPath: string,
  { keepOpen = false, dims = DIMS }: { keepOpen?: boolean; dims?: Dimensions } = {},
): Promise<{ emulator: HeadlessEmulator; bytes: number }> {
  if (!keepOpen) await tmuxExec(env, socket, 'pipe-pane -t main').catch(() => {});
  await sleep(150); // let `cat` write its last bytes
  const { stdout } = await execBytes(env.transport, remoteCommand(`cat ${rawPath}`));
  const emulator = new HeadlessEmulator({ ...dims, scrollback: SCROLLBACK, answerQueries: false });
  emulator.write(stdout);
  await emulator.flush();
  return { emulator, bytes: stdout.byteLength };
}

/** tmux's own current state, captured by an independent control client and rebuilt. */
export async function referenceFromTmux(env: TmuxEnv, socket: string): Promise<HeadlessEmulator> {
  const client = new TestControlClient(
    await env.transport.exec(launchCommand(launchOptions(env, socket, null))),
  );
  await client.waitFor((e) => e.type === 'sessionChanged');
  const result = await client.sendBatch(snapshotCommands(0));
  if (!result.ok) throw new Error('reference snapshot failed');
  const capture = parseCapture(result.blocks);
  const emulator = new HeadlessEmulator({
    cols: capture.state.width,
    rows: capture.state.height,
    scrollback: SCROLLBACK,
    answerQueries: false,
  });
  await rebuild(emulator, capture);
  client.detach();
  await client.exit;
  return emulator;
}

/** A session created by a plain control client, piped from its first byte, then released. */
export async function observedSession(
  env: TmuxEnv,
  socket: string,
): Promise<{ observer: TestControlClient; rawPath: string }> {
  const observer = new TestControlClient(
    await env.transport.exec(launchCommand(launchOptions(env, socket, BLOCKED_STARTUP))),
  );
  await observer.waitFor((e) => e.type === 'sessionChanged');
  const rawPath = await startPipe(env, socket);
  await observer.input(0, '\r');
  await observer.waitFor((e) => e.type === 'output' && Buffer.from(e.data).includes('$ '));
  await observer.waitIdle(300);
  return { observer, rawPath };
}

/**
 * A second control client that reads everything and keeps nothing: with it attached, tmux keeps
 * reading the pane even when the driver's client is not (tmux stops reading a pane only when
 * every attached client is a control client with a full output buffer).
 */
export async function drainClient(
  env: TmuxEnv,
  socket: string,
): Promise<{ close(): Promise<void> }> {
  const channel = await env.transport.exec(launchCommand(launchOptions(env, socket, null)));
  const done = (async () => {
    for await (const _chunk of channel.stdout) {
      // discard
    }
  })();
  return {
    close: async () => {
      channel.end();
      await done;
    },
  };
}

/** Local TCP proxy to an sshd container whose connections can be dropped abruptly. */
export class TcpProxy {
  readonly #server: Server;
  readonly #pairs = new Set<{ client: Socket; upstream: Socket }>();
  /** sshd sides kept open by abandonAll() (closed by close()). */
  readonly #abandoned = new Set<Socket>();
  port = 0;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(image: SshdImage): Promise<TcpProxy> {
    const proxy = new TcpProxy(
      createServer((client) => {
        const upstream = netConnect({ host: '127.0.0.1', port: SSHD_PORTS[image] });
        const pair = { client, upstream };
        proxy.#pairs.add(pair);
        for (const s of [client, upstream]) {
          s.on('close', () => proxy.#pairs.delete(pair));
          s.on('error', () => {});
        }
        client.pipe(upstream);
        upstream.pipe(client);
      }),
    );
    await new Promise<void>((resolve) => proxy.#server.listen(0, '127.0.0.1', resolve));
    proxy.port = (proxy.#server.address() as { port: number }).port;
    return proxy;
  }

  /** Simulated daemon death or network drop: both sides of every connection vanish at once. */
  dropAll(): void {
    for (const { client, upstream } of this.#pairs) {
      client.destroy();
      upstream.destroy();
    }
  }

  /**
   * Daemon death the remote does not notice (a vanished network path): our side of every
   * connection is destroyed while sshd's side stays open, so its sessions (e.g. a tmux control
   * client) linger as stale clients.
   */
  abandonAll(): void {
    for (const pair of this.#pairs) {
      pair.client.unpipe(pair.upstream);
      pair.upstream.unpipe(pair.client);
      pair.client.destroy();
      this.#abandoned.add(pair.upstream);
    }
    this.#pairs.clear();
  }

  async close(): Promise<void> {
    this.dropAll();
    for (const s of this.#abandoned) s.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/** Delegates to a transport and remembers the exec channels it opened (for buffer probes). */
export class TrackingTransport implements Transport {
  readonly channels: ExecChannel[] = [];
  readonly #inner: Transport;

  constructor(inner: Transport) {
    this.#inner = inner;
  }

  connect(signal: AbortSignal): Promise<void> {
    return this.#inner.connect(signal);
  }

  async exec(command: string): Promise<ExecChannel> {
    const channel = await this.#inner.exec(command);
    this.channels.push(channel);
    return channel;
  }

  openPty(opts: PtyOptions): Promise<PtyChannel> {
    return this.#inner.openPty(opts);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  onLost(cb: (err: TransportError) => void): void {
    this.#inner.onLost(cb);
  }

  /** Bytes queued locally on the first exec channel's stdout (the control channel). */
  get queuedStdout(): number {
    const stdout = this.channels[0]?.stdout as { bufferedBytes?: number } | undefined;
    return stdout?.bufferedBytes ?? 0;
  }
}

/** Process memory sample (MiB). */
export function memoryMiB(): { rss: number; heap: number; arrayBuffers: number } {
  const m = process.memoryUsage();
  const mib = (n: number): number => Math.round((n / 1024 / 1024) * 10) / 10;
  return { rss: mib(m.rss), heap: mib(m.heapUsed), arrayBuffers: mib(m.arrayBuffers) };
}

/** Tests honour TD_TMUX_IMAGES (comma-separated) to run against other images, e.g. tmux-3.4. */
export function selectedImages(defaults: SshdImage[]): SshdImage[] {
  const raw = process.env.TD_TMUX_IMAGES;
  return raw ? (raw.split(',').map((s) => s.trim()) as SshdImage[]) : defaults;
}
