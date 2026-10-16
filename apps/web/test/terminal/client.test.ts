import { readFileSync } from 'node:fs';
import { FrameType } from '@termdock/protocol';
import { XTERM_VERSION } from '@termdock/terminal-config';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChannelLimitError,
  TermdockConnection,
  type TerminalChannel,
} from '../../lib/terminal/index.ts';
import type { TerminalLike } from '../../lib/terminal/types.ts';
import {
  createClientTerminal,
  FakeServer,
  type FakeSocket,
  fingerprint,
  type HeadlessTerminal,
  ScriptedSession,
  sleep,
  summary,
  until,
  utf8,
} from './helpers.ts';

const SESSION = 'session-1';
const VIEWPORT = { cols: 100, rows: 30 };

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

function setup(server: FakeServer) {
  let ticketCalls = 0;
  const connection = new TermdockConnection({
    url: 'ws://termdock.test/ws',
    fetchTicket: async () => ({
      ticket: `ticket-${++ticketCalls}`,
      expiresAt: Date.now() + 30_000,
    }),
    createWebSocket: server.createWebSocket,
    backoff: { initialMs: 5, maxMs: 20, jitter: 0 },
    pingIntervalMs: 60_000,
  });
  cleanup.push(() => connection.close());
  return { connection, ticketCalls: () => ticketCalls };
}

function session(opts: ConstructorParameters<typeof ScriptedSession>[0] = {}): ScriptedSession {
  const s = new ScriptedSession(opts);
  cleanup.push(() => s.dispose());
  return s;
}

function attachedChannel(connection: TermdockConnection): {
  channel: TerminalChannel;
  term: HeadlessTerminal;
} {
  const term = createClientTerminal();
  cleanup.push(() => term.dispose());
  const channel = connection.openChannel({ terminal: term });
  channel.attach(SESSION, VIEWPORT);
  return { channel, term };
}

/** Client and server terminals hold identical state once every frame is applied. */
async function expectMirrors(channel: TerminalChannel, server: ScriptedSession): Promise<void> {
  await channel.settled();
  await server.emulator.flush();
  expect(fingerprint(channel.terminal as HeadlessTerminal)).toEqual(fingerprint(server.terminal));
}

/** Pre-snapshot history: colors, > scrollback lines, a split `—`, CJK, ZWJ emoji, a wrap. */
function history(s: ScriptedSession, channel: number): Uint8Array[] {
  const frames = [
    s.output(
      channel,
      '\x1b]2;fidelity\x07\x1b[1;31mred bold\x1b[0m \x1b[38;5;208morange\x1b[0m\r\n',
    ),
  ];
  for (let i = 0; i < 80; i++)
    frames.push(s.output(channel, `line ${i} ${'x'.repeat(i % 70)}\r\n`));
  const mixed = utf8('em—dash 日本語 👨‍👩‍👧 ');
  const split = mixed.indexOf(0x80) + 1; // right after E2 80: xterm 6 drops it unaligned
  frames.push(
    s.output(channel, mixed.subarray(0, split)),
    s.output(channel, mixed.subarray(split)),
  );
  frames.push(
    s.output(channel, `${'w'.repeat(100)}\r\n\x1b[3;10Hplaced\x1b[24;1H\x1b[4mul\x1b[24m`),
  );
  return frames;
}

describe('TerminalChannel', () => {
  it('mirrors the server: gzip SNAPSHOT, OUTPUT queued while decompressing, sequenced resizes', async () => {
    const server = new FakeServer();
    server.sessions = [summary(SESSION)];
    const s = session({ scrollbackLines: 50 });
    const pre = history(s, 1);
    server.onAttach = (socket, message) => {
      void (async () => {
        const snapshot = s.snapshot(message.channel); // barrier at seq = s.seq
        const after: Array<string | Uint8Array> = [
          // Already covered by the snapshot (seq ≤ snapshotSeq): must be dropped.
          pre.at(-2)!,
          pre.at(-1)!,
          s.output(1, 'after \x1b[32mgreen\x1b[0m\r\n'),
          s.resize(1, 100, 30),
          s.output(1, `${'wide '.repeat(30)}\r\n`),
        ];
        const ellipsis = utf8('…tail…\r\n'); // split inside E2 80 A6 across OUTPUT frames
        after.push(s.output(1, ellipsis.subarray(0, 2)), s.output(1, ellipsis.subarray(2)));
        after.push(
          s.resize(1, 60, 20), // shrink: wrapped lines reflow at exactly this position
          s.output(1, 'after shrink\r\n\x1b[5 q'),
          s.resized(1, false), // same size, only flips activeAttachment
          s.output(1, 'end'),
        );
        const frames = [s.attached(1, message.sessionId), await snapshot, ...after];
        for (const frame of frames) socket.deliver(frame); // one burst, while decompressing
      })();
    };
    const { connection } = setup(server);
    connection.connect();
    const { channel, term } = attachedChannel(connection);
    await until(() => channel.getSnapshot().phase === 'live', 3_000, 'live');
    await expectMirrors(channel, s);
    expect(channel.getSnapshot()).toMatchObject({
      phase: 'live',
      sessionId: SESSION,
      size: { cols: 60, rows: 20 },
      scrollbackLines: 50,
      active: false,
    });
    expect(term.options.scrollback).toBe(50);

    // Keystrokes become INPUT frames on this channel.
    term.input('ls -l\r', true);
    const input = server.last.binary.at(-1)!;
    expect(input).toMatchObject({ type: FrameType.Input, channel: channel.id, seq: 0n });
    expect(new TextDecoder().decode(input.payload)).toBe('ls -l\r');
  });

  it('a second session.attached + SNAPSHOT on the same channel replaces the state', async () => {
    const server = new FakeServer();
    server.sessions = [summary(SESSION)];
    const first = session();
    history(first, 1);
    let socket: FakeSocket | null = null;
    server.onAttach = (sock, message) => {
      socket = sock;
      void first.snapshot(1).then((snap) => {
        sock.deliver(first.attached(1, message.sessionId));
        sock.deliver(snap);
        sock.deliver(first.output(1, 'first runtime\r\n'));
      });
    };
    const { connection } = setup(server);
    connection.connect();
    const { channel } = attachedChannel(connection);
    await until(() => channel.getSnapshot().phase === 'live');
    await expectMirrors(channel, first);

    // Reopen / rebuild: a new runtime with another size, scrollback and a lower seq. Late output
    // of the old runtime is still unparsed in xterm when the (here uncompressed) snapshot lands,
    // and ends inside a UTF-8 character that must not leak into the new stream.
    const second = session({ cols: 90, rows: 25, scrollbackLines: 30 });
    second.output(1, 'new shell\r\n\x1b[?1049h\x1b[2J\x1b[H\x1b[7mfull screen\x1b[27m\x1b[3 q');
    const snap = await second.snapshot(1, false);
    const frames = [
      first.output(1, `${'late old output '.repeat(20)}\r\n`),
      first.output(1, utf8('…').subarray(0, 2)),
      second.attached(1, SESSION),
      snap,
      second.output(1, '\x1b[10;5Hmoved'),
      second.output(1, ' — more'),
    ];
    for (const frame of frames) socket!.deliver(frame);
    await expectMirrors(channel, second);
    expect(channel.getSnapshot()).toMatchObject({
      phase: 'live',
      size: { cols: 90, rows: 25 },
      scrollbackLines: 30,
    });
  });
});

describe('TermdockConnection', () => {
  it('reconnects after an abnormal close with a fresh ticket and re-attaches every channel', async () => {
    const server = new FakeServer();
    server.sessions = [summary(SESSION), summary('session-2', { status: 'action_required' })];
    server.pendingPrompts = [
      {
        type: 'hostkey.prompt',
        sessionId: 'session-2',
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:abc',
        mismatch: false,
      },
    ];
    const s = session();
    history(s, 1);
    server.onAttach = (sock, message) => {
      void s.snapshot(message.channel).then((snap) => {
        sock.deliver(s.attached(message.channel, message.sessionId));
        sock.deliver(snap);
      });
    };
    const { connection, ticketCalls } = setup(server);
    connection.connect();
    const { channel } = attachedChannel(connection);
    await until(() => channel.getSnapshot().phase === 'live');
    expect(connection.getSnapshot()).toMatchObject({ status: 'open', userId: 'u1' });
    expect(connection.getSnapshot().hostKeyPrompts['session-2']).toMatchObject({
      fingerprint: 'SHA256:abc',
    });
    server.last.deliver(
      JSON.stringify({
        type: 'session.status',
        sessionId: SESSION,
        status: 'connected',
        state: 'ready',
        detail: 'remote_rebooted',
      }),
    );
    channel.setViewport({ cols: 120, rows: 40 }); // remembered for the re-attach
    await sleep(60);

    // The session keeps producing output while the tab is disconnected.
    server.last.serverClose(1006);
    expect(connection.getSnapshot().status).toBe('reconnecting');
    expect(channel.getSnapshot().phase).toBe('attaching');
    s.output(1, 'while you were away\r\n');
    await until(() => channel.getSnapshot().phase === 'live' && server.sockets.length === 2);

    expect(ticketCalls()).toBe(2);
    expect(server.tickets).toEqual(['ticket-1', 'ticket-2']);
    expect(server.sockets[1]!.control.find((m) => m.type === 'session.attach')).toEqual({
      type: 'session.attach',
      channel: channel.id,
      sessionId: SESSION,
      viewport: { cols: 120, rows: 40 },
    });
    await expectMirrors(channel, s);
    const state = connection.getSnapshot();
    expect(state).toMatchObject({ status: 'open', attempt: 0, error: null });
    // The latch survives the new sessions.list; the pending prompt was replayed.
    expect(state.sessions.find((e) => e.id === SESSION)?.remoteRebooted).toBe(true);
    expect(Object.keys(state.hostKeyPrompts)).toEqual(['session-2']);
  });

  it('4401 surfaces as unauthenticated and does not reconnect', async () => {
    const server = new FakeServer();
    const { connection, ticketCalls } = setup(server);
    connection.connect();
    await until(() => connection.getSnapshot().status === 'open');
    server.last.serverClose(4401, 'revoked');
    await sleep(50); // several backoff periods
    expect(connection.getSnapshot()).toMatchObject({
      status: 'closed',
      error: { kind: 'unauthenticated', code: 4401 },
      retryAt: null,
    });
    expect(ticketCalls()).toBe(1);
    expect(server.sockets).toHaveLength(1);
  });

  it('allocates at most 32 channels per connection', () => {
    const { connection } = setup(new FakeServer());
    const noop = { dispose() {} };
    const stub = (): TerminalLike =>
      ({
        cols: 80,
        rows: 24,
        options: {},
        write() {},
        reset() {},
        resize() {},
        onData: () => noop,
        onBinary: () => noop,
        parser: {},
      }) as unknown as TerminalLike;
    const channels = Array.from({ length: 32 }, () => connection.openChannel({ terminal: stub() }));
    expect(new Set(channels.map((c) => c.id)).size).toBe(32);
    expect(() => connection.openChannel({ terminal: stub() })).toThrow(ChannelLimitError);
    channels[5]!.dispose();
    const reopened = connection.openChannel({ terminal: stub() });
    expect(channels.map((c) => c.id)).not.toContain(reopened.id); // numbers are not reused soon
  });
});

it('the browser pins the same @xterm/xterm version as the server emulator', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../node_modules/@xterm/xterm/package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  expect(pkg.version).toBe(XTERM_VERSION);
});
