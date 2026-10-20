// T0: what a hostile or broken host sends over the tmux control channel stays contained: reply
// text that reaches the logs and the `desync` session event is cleaned and capped, and a reply
// block that never ends drops the control client instead of growing until the daemon runs out of
// memory. The real TmuxControlDriver runs inside a SessionRuntime against a scripted tmux.
import { Writable } from 'node:stream';
import { isControlChar, isInvisibleFormatChar } from '@termavox/protocol';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createDriverFactory } from '../../src/core/driver-factory.ts';
import { SessionRuntime } from '../../src/core/session-runtime.ts';
import type { TransportHooks } from '../../src/core/transport-factory.ts';
import type { SessionRecord } from '../../src/core/types.ts';
import {
  DEFAULT_MAX_UNSOLICITED_BLOCK_BYTES,
  HOST_TEXT_MAX,
  hostMessage,
  hostText,
  SESSION_CREATED_MARKER,
  snapshotCommands,
  TmuxControlDriver,
} from '../../src/drivers/tmux-control/index.ts';
import {
  encode,
  FakePtyChannel,
  FakeTransport,
  FakeTransportFactory,
  MemoryHostKeyStore,
  MemorySessionStore,
  makeRecord,
  RecordingNotifier,
  TMUX_PROBE,
  until,
} from '../runtime/fakes.ts';

const decoder = new TextDecoder();
/** Escape sequences (7-bit and C1), a bidi override and a zero-width space, about 64 KiB a line. */
const NOISE = '\x1b[31mred\x1b[0m \x1b]0;title\x07 \u009b2J‮evil​ '.repeat(1600);
/** About 1 MiB of it: what the host answers instead of a reply. */
const HUGE = Array.from({ length: 16 }, () => NOISE);
const SNAPSHOT = snapshotCommands(0);
const ROWS = Array.from({ length: 24 }, () => ' '.repeat(80));
/** STATE_FORMAT of an 80x24 pane %0 with no history (tmux 3.4: the newer fields empty). */
const STATE = [
  ...['%0', '80', '24', '0', '0', '0', '0', '', '', '0', '23'],
  ...['1', '0', '0', '0', '1', '0', '0', '0', '0', '0', '0', '0', ''],
  ...['', '', '', '', 'box', 'box', 'box'],
].join('\t');
/** One flags-0 block per launch argv command; the last one says it created the session. */
const LAUNCH_BLOCKS = 9;

/** The reply lines of a command the scripted tmux knows. */
function reply(command: string): string[] {
  const sentinel = /^display-message -p '(tv-[A-Za-z0-9_-]+)'$/.exec(command);
  if (sentinel) return [sentinel[1]!];
  const snapshot = SNAPSHOT.indexOf(command);
  if (snapshot !== -1) return [[], ROWS, ROWS, [], [], [STATE], []][snapshot]!;
  if (command.includes('#{client_name}')) return ['client-1'];
  if (command.includes('#{session_created}')) return ['1700000000 4242 %0 @0'];
  if (command.includes('#{window_id} #{pane_id}')) return ['@0 %0'];
  if (command.includes('#{pane_current_command}')) return ['bash'];
  if (command.includes('#{pane_in_mode}')) return ['0'];
  return []; // list-clients (no other client), refresh-client, send-keys …
}

/** A scripted tmux control client: the launch blocks, then one block per command written. */
class FakeTmux {
  /** Commands answered with an `%error` block of HUGE (tmux then skips the rest of the line). */
  failing: (command: string) => boolean = () => false;
  channel: TmuxChannel | null = null;

  open(): TmuxChannel {
    this.channel = new TmuxChannel(this);
    return this.channel;
  }
}

class TmuxChannel extends FakePtyChannel {
  readonly #tmux: FakeTmux;
  #num = 0;
  #partial = '';

  constructor(tmux: FakeTmux) {
    super();
    this.#tmux = tmux;
    for (let i = 1; i <= LAUNCH_BLOCKS; i++) {
      this.#block(0, i === LAUNCH_BLOCKS ? [SESSION_CREATED_MARKER] : []);
    }
    this.say('%session-changed $0 main');
  }

  say(...lines: string[]): void {
    this.stdout.push(encode(lines.map((l) => `${l}\n`).join('')));
  }

  #block(flags: number, lines: string[], end = 'end'): void {
    const guard = `1700000000 ${++this.#num} ${flags}`;
    this.say(`%begin ${guard}`, ...lines, `%${end} ${guard}`);
  }

  override write(data: Uint8Array): void {
    super.write(data);
    this.#partial += decoder.decode(data);
    for (let at = this.#partial.indexOf('\n'); at !== -1; at = this.#partial.indexOf('\n')) {
      const line = this.#partial.slice(0, at);
      this.#partial = this.#partial.slice(at + 1);
      if (line === '') {
        this.say('%exit'); // an empty line detaches the control client
        this.finish({ code: 0, signal: null });
        return;
      }
      for (const command of line.split(' ; ')) {
        if (this.#tmux.failing(command)) {
          this.#block(1, HUGE, 'error');
          break;
        }
        this.#block(1, reply(command));
      }
    }
  }

  /** tmux exits when its stdin ends. */
  override end(): void {
    super.end();
    this.finish({ code: 0, signal: null });
  }
}

/** A host whose tmux launch runs the scripted control client; other commands as FakeTransport. */
class TmuxHostFactory extends FakeTransportFactory {
  readonly tmux = new FakeTmux();

  override async create(_record: SessionRecord, hooks: TransportHooks): Promise<FakeTransport> {
    const tmux = this.tmux;
    const transport = new (class extends FakeTransport {
      override async exec(command: string): Promise<FakePtyChannel> {
        if (!command.includes('-f /dev/null -C ')) return super.exec(command);
        this.commands.push(command);
        return tmux.open();
      }
    })(hooks, { probe: TMUX_PROBE });
    this.created.push(transport);
    return transport;
  }
}

function setup() {
  const store = new MemorySessionStore();
  const factory = new TmuxHostFactory();
  const logs: Array<{ level: number; msg: string; err?: { message?: string } }> = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      logs.push(JSON.parse(String(chunk)));
      done();
    },
  });
  const runtime = new SessionRuntime({
    record: store.add(makeRecord()),
    store,
    hostKeys: new MemoryHostKeyStore(),
    transports: factory,
    drivers: createDriverFactory((opts) => new TmuxControlDriver(opts)),
    notifier: new RecordingNotifier(),
    installationId: 'install-1',
    resizeDebounceMs: 1,
    lagPollMs: 5,
    logger: pino({ level: 'warn' }, sink),
  });
  const desyncs = () =>
    store.events.filter((e) => e.type === 'desync').map((e) => String(e.detail?.reason));
  return { store, factory, tmux: factory.tmux, logs, runtime, desyncs };
}

/** No C0/C1 control and no invisible formatting character left. */
function clean(text: string): boolean {
  return [...text].every((ch) => {
    const code = ch.codePointAt(0)!;
    return !isControlChar(code) && !isInvisibleFormatChar(code);
  });
}

describe('host text in errors, logs and session events', () => {
  it('hostText joins lines, drops controls and invisible formatting, and caps without splitting', () => {
    expect(hostText([encode('a\x1b[1mb'), encode('c‮d​')])).toBe('a[1mb cd');
    expect(hostText(HUGE.map(encode))).toHaveLength(HOST_TEXT_MAX);
    expect(clean(hostText(HUGE.map(encode)))).toBe(true);
    expect(hostText('😀'.repeat(200))).toBe('😀'.repeat(HOST_TEXT_MAX / 2));
    expect(hostText('ab😀', 3)).toBe('ab');
    const message = hostMessage("'display-message' failed: ", HUGE.map(encode));
    expect(message.startsWith("'display-message' failed: [31mred[0m ]0;title 2Jevil ")).toBe(true);
    expect(message).toHaveLength(HOST_TEXT_MAX);
    expect(hostMessage('exited (', 'x'.repeat(1000), ')')).toHaveLength(HOST_TEXT_MAX);
    expect(hostMessage('control channel closed', '')).toBe('control channel closed');
  });

  it('a 1 MiB %error reply during start: the warn log carries at most 300 clean characters', async () => {
    const { tmux, logs, runtime } = setup();
    tmux.failing = (command) => command.includes('#{client_name}');
    await runtime.start();
    await until(() => logs.some((l) => l.msg === 'session start failed'));
    const entry = logs.find((l) => l.msg === 'session start failed')!;
    const message = entry.err?.message ?? '';
    expect(message.startsWith("'display-message' failed: [31mred")).toBe(true);
    expect(message.length).toBeLessThanOrEqual(HOST_TEXT_MAX);
    expect(clean(message)).toBe(true);
    expect(JSON.stringify(logs).length).toBeLessThan(4096);
    await until(() => runtime.state === 'reconnecting');
    await runtime.shutdown();
  });

  it('a 1 MiB %error reply to the snapshot while running: the desync event is capped and clean', async () => {
    const { tmux, runtime, desyncs } = setup();
    await runtime.start();
    expect(runtime.state).toBe('ready');
    // After a %pause the driver retakes the snapshot (continue first); every attempt fails.
    tmux.failing = (command) => command.startsWith('refresh-client -A') || command === SNAPSHOT[0];
    tmux.channel!.say('%pause %0');
    await until(() => desyncs().length > 0);
    const [reason] = desyncs();
    expect(reason!.startsWith('snapshot (pause) failed: [31mred')).toBe(true);
    expect(reason!.length).toBeLessThanOrEqual(HOST_TEXT_MAX);
    expect(clean(reason!)).toBe(true);
    await runtime.shutdown();
  });
});

describe('a reply block that never ends', () => {
  it('drops the control client at the cap and reconnects only after the backoff', async () => {
    const { tmux, factory, runtime, desyncs } = setup();
    await runtime.start();
    expect(runtime.state).toBe('ready');
    // An unsolicited block (flags 0) that goes past its cap without a closing guard.
    const line = 'x'.repeat(1023);
    const lines = Array.from(
      { length: DEFAULT_MAX_UNSOLICITED_BLOCK_BYTES / 1024 + 1 },
      () => line,
    );
    tmux.channel!.say('%begin 1700000000 999 0', ...lines);
    await until(() => desyncs().length > 0);
    expect(desyncs()).toEqual([
      `control-mode reply block exceeds ${DEFAULT_MAX_UNSOLICITED_BLOCK_BYTES} bytes`,
    ]);
    await until(() => runtime.state === 'reconnecting');
    expect(factory.last.closed).toBe(true);
    // The reconnect round waits about 2 s first: no hot loop of logins.
    const wait = runtime.retryStatus();
    expect(wait).toMatchObject({ type: 'session.status', state: 'reconnecting' });
    expect((wait as { retryInMs?: number }).retryInMs).toBeGreaterThan(1_000);
    expect(factory.created).toHaveLength(1);
    await runtime.shutdown();
  });
});
