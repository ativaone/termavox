import { readFileSync } from 'node:fs';
import { FrameType } from '@termavox/protocol';
import { XTERM_VERSION } from '@termavox/terminal-config';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AuthPromptRequest,
  ChannelLimitError,
  RATE_LIMITED_RETRY_MS,
  TermavoxConnection,
  type TerminalChannel,
} from '../../lib/terminal/index.ts';
import type { TerminalLike } from '../../lib/terminal/types.ts';
import { chooseOverlay } from '../../lib/workspace/overlay.ts';
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
  const connection = new TermavoxConnection({
    url: 'ws://termavox.test/ws',
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

function attachedChannel(connection: TermavoxConnection): {
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

  it('keeps the pane hint until it is cleared or the session is attached again (D-33)', async () => {
    const server = new FakeServer();
    server.sessions = [summary(SESSION)];
    const s = session();
    let socket: FakeSocket | null = null;
    const hint = (value: string | null) =>
      JSON.stringify({ type: 'terminal.hint', channel: 1, hint: value });
    server.onAttach = (sock, message) => {
      socket = sock;
      void s.snapshot(1).then((snap) => {
        sock.deliver(s.attached(1, message.sessionId));
        sock.deliver(hint('nested_tmux')); // a late attach gets the current hint
        sock.deliver(snap);
      });
    };
    const { connection } = setup(server);
    connection.connect();
    const { channel } = attachedChannel(connection);
    await until(() => channel.getSnapshot().phase === 'live');
    expect(channel.getSnapshot().hint).toBe('nested_tmux');
    socket!.deliver(hint(null));
    await until(() => channel.getSnapshot().hint === null);
    socket!.deliver(hint('nested_tmux'));
    await until(() => channel.getSnapshot().hint === 'nested_tmux');
    // A new attach confirmation without a hint after it drops the old one.
    socket!.deliver(s.attached(1, SESSION));
    await until(() => channel.getSnapshot().hint === null);
  });

  it('sends focus reports for a real focus change only, never because the output asked', async () => {
    const server = new FakeServer();
    server.sessions = [summary(SESSION)];
    const s = session();
    let socket: FakeSocket | null = null;
    server.onAttach = (sock, message) => {
      socket = sock;
      sock.deliver(s.attached(message.channel, message.sessionId));
    };
    const { connection } = setup(server);
    connection.connect();
    // A browser terminal's surface: xterm's onData and its textarea's focus and blur.
    const noop = { dispose() {} };
    const textarea = new EventTarget();
    const modes = { sendFocusMode: true };
    let emitData: (data: string) => void = () => {};
    const terminal = {
      cols: 80,
      rows: 24,
      options: {},
      modes,
      textarea,
      write(_data: unknown, callback?: () => void) {
        callback?.();
      },
      reset() {},
      resize() {},
      onData: (listener: (data: string) => void) => {
        emitData = listener;
        return noop;
      },
      onBinary: () => noop,
      parser: {},
    } as unknown as TerminalLike;
    const channel = connection.openChannel({ terminal });
    channel.attach(SESSION, VIEWPORT);
    await until(() => channel.getSnapshot().phase === 'syncing');
    const inputs = () =>
      server.last.binary
        .filter((frame) => frame.type === FrameType.Input)
        .map((frame) => new TextDecoder().decode(frame.payload));

    // `ESC[?1004h` in the output makes xterm report the focus by itself: never sent.
    emitData('\x1b[I');
    emitData('\x1b[O');
    expect(inputs()).toEqual([]);
    emitData('a');
    expect(inputs()).toEqual(['a']);

    // A real focus while the program asked for reports.
    textarea.dispatchEvent(new Event('focus'));
    expect(inputs()).toEqual(['a', '\x1b[I']);
    // Not asked for: nothing either way.
    modes.sendFocusMode = false;
    textarea.dispatchEvent(new Event('focus'));
    textarea.dispatchEvent(new Event('blur'));
    expect(inputs()).toEqual(['a', '\x1b[I']);
    // Focus-out comes only from the active attachment (INPUT would make a left pane active).
    modes.sendFocusMode = true;
    textarea.dispatchEvent(new Event('blur'));
    expect(inputs()).toEqual(['a', '\x1b[I']);
    socket!.deliver(s.resized(channel.id, true));
    await until(() => channel.getSnapshot().active, 3_000, 'active');
    textarea.dispatchEvent(new Event('blur'));
    expect(inputs()).toEqual(['a', '\x1b[I', '\x1b[O']);
  });
});

describe('TermavoxConnection', () => {
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

  it('a fresh page reads the failure reason and a pending reboot notice from the list', async () => {
    const server = new FakeServer();
    const failed = {
      state: 'failed',
      status: 'disconnected',
      statusDetail: 'AUTH_REJECTED',
    } as const;
    server.sessions = [
      summary('failed', failed),
      summary('rebooted', { statusDetail: 'remote_rebooted' }),
    ];
    const { connection } = setup(server);
    connection.connect();
    await until(() => connection.getSnapshot().sessionsLoaded);
    const entry = (id: string) => connection.getSnapshot().sessions.find((e) => e.id === id);
    // The pane's Disconnected slip reads `detail` (pane-overlays.tsx).
    expect(entry('failed')).toMatchObject({ detail: 'AUTH_REJECTED', remoteRebooted: false });
    expect(entry('rebooted')).toMatchObject({ remoteRebooted: true });
    // Dismissed stays dismissed when the summary comes again.
    connection.acknowledgeRemoteReboot('rebooted');
    server.last.deliver(
      JSON.stringify({
        type: 'session.upsert',
        session: summary('rebooted', { statusDetail: 'remote_rebooted' }),
      }),
    );
    expect(entry('rebooted')).toMatchObject({ detail: 'remote_rebooted', remoteRebooted: false });
    // A reboot that happened while the tab was offline latches with the next list.
    server.last.deliver(
      JSON.stringify({
        type: 'sessions.list',
        sessions: [summary('failed', { statusDetail: 'remote_rebooted' })],
      }),
    );
    expect(entry('failed')).toMatchObject({ detail: 'remote_rebooted', remoteRebooted: true });
  });

  it('takes a rename from session.upsert, and the renaming tab’s own result unless newer', async () => {
    const server = new FakeServer();
    server.sessions = [summary('a'), summary('b')];
    const { connection } = setup(server);
    connection.connect();
    await until(() => connection.getSnapshot().sessionsLoaded);
    const label = (id: string) => connection.getSnapshot().sessions.find((e) => e.id === id)?.label;
    const upsert = (id: string, name: string) =>
      server.last.deliver(
        JSON.stringify({ type: 'session.upsert', session: summary(id, { label: name }) }),
      );
    // Another browser renamed `a`: the daemon's upsert arrives on the socket already open.
    upsert('a', 'deploy');
    expect(label('a')).toBe('deploy');
    expect(connection.getSnapshot().sessions.map((e) => e.id)).toEqual(['a', 'b']);
    // This tab renamed `b`: shown at once, before the upsert.
    connection.applyRename('b', 'logs', 'session b');
    expect(label('b')).toBe('logs');
    // A late result never overwrites a newer name that already arrived from elsewhere.
    upsert('a', 'newer');
    connection.applyRename('a', 'older', 'deploy');
    expect(label('a')).toBe('newer');
    const before = connection.getSnapshot().sessions;
    connection.applyRename('unknown', 'x', 'session unknown');
    expect(connection.getSnapshot().sessions).toBe(before);
  });

  it('keeps a pending remote cleanup while the tab lives, until the session is reopened', async () => {
    const server = new FakeServer();
    server.sessions = [summary('a'), summary('b')];
    const { connection } = setup(server);
    connection.connect();
    await until(() => connection.getSnapshot().sessionsLoaded);
    const entry = (id: string) => connection.getSnapshot().sessions.find((e) => e.id === id);
    const status = (id: string, extra: Record<string, unknown>) =>
      server.last.deliver(JSON.stringify({ type: 'session.status', sessionId: id, ...extra }));
    // Plan D-30: the session ended, but its tmux on the server could not be ended now.
    status('a', { status: 'ended', state: 'ended', remoteCleanup: 'pending' });
    status('b', { status: 'ended', state: 'ended' });
    expect(entry('a')).toMatchObject({ status: 'ended', remoteCleanup: true });
    expect(entry('b')).toMatchObject({ remoteCleanup: false });
    // Not part of the summary: a later upsert or list (reconnect) keeps it.
    const ended = { state: 'ended', status: 'ended', endReason: 'user_terminated' } as const;
    server.last.deliver(JSON.stringify({ type: 'session.upsert', session: summary('a', ended) }));
    server.last.deliver(JSON.stringify({ type: 'sessions.list', sessions: [summary('a', ended)] }));
    expect(entry('a')).toMatchObject({ remoteCleanup: true });
    // Reopened: the line goes away and does not come back with a plain end.
    status('a', { status: 'connecting', state: 'connecting' });
    expect(entry('a')).toMatchObject({ remoteCleanup: false });
    status('a', { status: 'ended', state: 'ended' });
    expect(entry('a')).toMatchObject({ remoteCleanup: false });
  });

  it("keeps a retry round's progress from its statuses, and drops it once the round is over", async () => {
    const server = new FakeServer();
    server.sessions = [summary('a')];
    const { connection } = setup(server);
    connection.connect();
    await until(() => connection.getSnapshot().sessionsLoaded);
    const entry = () => connection.getSnapshot().sessions.find((e) => e.id === 'a');
    const status = (extra: Record<string, unknown>) =>
      server.last.deliver(JSON.stringify({ type: 'session.status', sessionId: 'a', ...extra }));
    // Plan D-31: a session that never connected counts its attempts.
    status({
      status: 'reconnecting',
      state: 'reconnecting',
      retryInMs: 5_000,
      attempt: 2,
      maxAttempts: 4,
    });
    expect(entry()).toMatchObject({
      attempt: 2,
      maxAttempts: 4,
      retryUntil: null,
      retryInMs: 5_000,
    });
    status({ status: 'connecting', state: 'connecting', attempt: 2, maxAttempts: 4 });
    expect(entry()).toMatchObject({ attempt: 2, maxAttempts: 4 });
    // An upsert (the summary carries no progress) keeps it.
    server.last.deliver(JSON.stringify({ type: 'session.upsert', session: summary('a') }));
    expect(entry()).toMatchObject({ attempt: 2, maxAttempts: 4 });
    status({ status: 'disconnected', state: 'failed', detail: 'HOST_UNREACHABLE' });
    expect(entry()).toMatchObject({ attempt: null, maxAttempts: null, retryUntil: null });
    // One that lost its connection retries until a deadline.
    status({ status: 'reconnecting', state: 'reconnecting', retryInMs: 2_000, retryUntil: 99 });
    expect(entry()).toMatchObject({ attempt: null, retryUntil: 99 });
  });

  it('trades an expired sign-in prompt for the waiting card with Retry (§5.10)', async () => {
    const server = new FakeServer();
    const waiting = { state: 'awaiting_user_input', status: 'action_required' } as const;
    server.sessions = [summary('a', waiting)];
    const prompt = (promptId: string): AuthPromptRequest => ({
      type: 'auth.prompt',
      sessionId: 'a',
      promptId,
      name: '',
      instructions: '',
      prompts: [{ text: 'Password: ', echo: false }],
    });
    server.pendingPrompts = [prompt('p1')];
    const { connection } = setup(server);
    connection.connect();
    await until(() => connection.getSnapshot().authPrompts.a !== undefined);
    const status = (extra: Record<string, unknown> = {}) =>
      server.last.deliver(
        JSON.stringify({ type: 'session.status', sessionId: 'a', ...waiting, ...extra }),
      );
    // What the pane draws over the session (pane-overlays.tsx).
    const overlay = () => {
      const state = connection.getSnapshot();
      return chooseOverlay(
        'a',
        state.sessions.find((e) => e.id === 'a'),
        false,
        {
          hostKey: state.hostKeyPrompts.a,
          auth: state.authPrompts.a,
        },
      );
    };
    expect(overlay()).toEqual({ kind: 'auth', prompt: prompt('p1') });
    // The status that asks for an answer comes before its prompt, without a detail: kept.
    status();
    expect(overlay()).toEqual({ kind: 'auth', prompt: prompt('p1') });

    // The daemon withdrew the prompt: the form goes at once, the waiting card offers Retry.
    status({ detail: 'AUTH_TIMEOUT' });
    expect(connection.getSnapshot().authPrompts).toEqual({});
    expect(connection.getSnapshot().sessions[0]).toMatchObject({
      status: 'action_required',
      detail: 'AUTH_TIMEOUT',
    });
    expect(overlay()).toEqual({ kind: 'actionWait' });

    // A page that connects now: the list says why, and no prompt is replayed.
    server.pendingPrompts = [];
    server.sessions = [summary('a', { ...waiting, statusDetail: 'AUTH_TIMEOUT' })];
    server.last.serverClose(1006);
    await until(() => server.sockets.length === 2 && connection.getSnapshot().status === 'open');
    expect(overlay()).toEqual({ kind: 'actionWait' });

    // Retry: the server asks again, and the form comes back with the new prompt.
    status({ status: 'connecting', state: 'connecting' });
    status();
    server.last.deliver(JSON.stringify(prompt('p2')));
    expect(overlay()).toEqual({ kind: 'auth', prompt: prompt('p2') });
  });

  it('shows one remote-sessions notice per server; a dismissed one stays quiet', async () => {
    const server = new FakeServer();
    const { connection } = setup(server);
    connection.connect();
    await until(() => connection.getSnapshot().sessionsLoaded);
    const found = (serverId: string, serverName: string, count: number) =>
      server.last.deliver(
        JSON.stringify({ type: 'server.remote_sessions', serverId, serverName, count }),
      );
    found('s1', 'build', 2);
    found('s2', 'db', 1);
    found('s1', 'build box', 3); // the same server again: updated in place, not repeated
    expect(connection.getSnapshot().remoteSessions).toEqual([
      { serverId: 's1', serverName: 'build box', count: 3 },
      { serverId: 's2', serverName: 'db', count: 1 },
    ]);
    connection.dismissRemoteSessions('s1');
    expect(connection.getSnapshot().remoteSessions.map((n) => n.serverId)).toEqual(['s2']);
    // Dismissed for the rest of the tab's life, across a reconnect too.
    server.last.serverClose(1006);
    await until(() => connection.getSnapshot().status === 'open' && server.sockets.length === 2);
    found('s1', 'build box', 4);
    expect(connection.getSnapshot().remoteSessions.map((n) => n.serverId)).toEqual(['s2']);
    const before = connection.getSnapshot();
    connection.dismissRemoteSessions('unknown');
    expect(connection.getSnapshot()).toBe(before);
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

  it('4429 (too many windows) is remembered and backs off at least 10 s: no hot loop', async () => {
    const server = new FakeServer();
    const { connection, ticketCalls } = setup(server); // backoff 5–20 ms
    connection.connect();
    await until(() => connection.getSnapshot().status === 'open');
    const closedAt = Date.now();
    server.last.serverClose(4429, 'too many connections');
    await sleep(80); // many ordinary backoff periods
    const state = connection.getSnapshot();
    expect(state).toMatchObject({ status: 'reconnecting', closeCode: 4429, error: null });
    expect(state.retryAt! - closedAt).toBeGreaterThanOrEqual(RATE_LIMITED_RETRY_MS);
    expect(ticketCalls()).toBe(1);
    expect(server.sockets).toHaveLength(1);

    // "Retry now" after closing another window: accepted, and the remembered code clears.
    connection.retryNow();
    await until(() => connection.getSnapshot().status === 'open');
    expect(connection.getSnapshot().closeCode).toBeNull();
    expect(ticketCalls()).toBe(2);

    // Any other abnormal close keeps the ordinary backoff.
    server.last.serverClose(1006);
    expect(connection.getSnapshot().closeCode).toBe(1006);
    await until(() => connection.getSnapshot().status === 'open' && server.sockets.length === 3);
  });

  it('an attach refused with RATE_LIMITED fails the pane until attached again', async () => {
    const server = new FakeServer();
    let refuse = true;
    server.onAttach = (sock, message) => {
      if (refuse) {
        sock.deliver(
          JSON.stringify({
            type: 'error',
            code: 'RATE_LIMITED',
            message: 'too many attached terminals',
            channel: message.channel,
            sessionId: message.sessionId,
          }),
        );
        return;
      }
      sock.deliver(
        JSON.stringify({
          type: 'session.attached',
          channel: message.channel,
          sessionId: message.sessionId,
          cols: 100,
          rows: 30,
          scrollbackLines: 0,
        }),
      );
    };
    const { connection } = setup(server);
    connection.connect();
    const { channel } = attachedChannel(connection);
    await until(() => channel.getSnapshot().phase === 'failed');
    expect(channel.getSnapshot().error).toEqual({
      code: 'RATE_LIMITED',
      message: 'too many attached terminals',
    });
    // A reconnect does not retry a refused attach on its own…
    server.last.serverClose(1006);
    await until(() => connection.getSnapshot().status === 'open' && server.sockets.length === 2);
    expect(server.last.control.filter((m) => m.type === 'session.attach')).toHaveLength(0);
    // …the pane's "Try again" does.
    refuse = false;
    channel.attach(SESSION, VIEWPORT);
    await until(() => channel.getSnapshot().phase === 'syncing');
    expect(channel.getSnapshot().error).toBeNull();
  });

  it('hands session.bell to its subscribers, attached to the session or not', async () => {
    const server = new FakeServer();
    server.sessions = [summary(SESSION, { notify: true })];
    const { connection } = setup(server);
    const heard: Array<{ sessionId: string; title: string | null }> = [];
    const stop = connection.subscribeBells((bell) => heard.push(bell));
    connection.connect();
    await until(() => connection.getSnapshot().status === 'open');
    const bell = { type: 'session.bell', sessionId: SESSION, title: 'build: done' };
    server.last.deliver(JSON.stringify(bell));
    await until(() => heard.length === 1);
    expect(heard).toEqual([{ sessionId: SESSION, title: 'build: done' }]);
    stop();
    server.last.deliver(JSON.stringify(bell));
    await sleep(20);
    expect(heard).toHaveLength(1);
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
