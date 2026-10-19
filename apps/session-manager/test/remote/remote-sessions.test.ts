// T0: remote tmux leftovers (plan D-30): the scan command, its strict parser, the classification
// against session records, ending leftovers (re-check and 60 s guard) and the background sweep
// (rate limit, notify once). The scan script itself runs on real tmux in
// test/tmux/remote-scan.int.test.ts.
import type { SessionState } from '@termdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  classifySocket,
  ENDED_GUARD_MS,
  endLeftovers,
  NOTIFIED_MAX,
  parseRemoteScan,
  REMOTE_SCAN_MAX_ENTRIES,
  RemoteSweeper,
  SWEEP_INTERVAL_MS,
} from '../../src/core/remote-sessions.ts';
import type { RemoteSessionLookup, SessionEventInput, SocketOwner } from '../../src/core/types.ts';
import {
  killServerCommand,
  SCAN_SESSION_FORMAT,
  scanSocketsCommand,
  serverAnswersCommand,
} from '../../src/drivers/tmux-control/commands.ts';
import { type FakeExecResult, FakeTransport, RecordingNotifier } from '../runtime/fakes.ts';

const PREFIX = 'aaaa1111';
const own = (token: string): string => `td-${PREFIX}-${token}`;
const TOKEN_A = 'abcdefghijkl';
const TOKEN_B = 'mnopqrstuvwx';
const TOKEN_C = 'yz234567abcd';
const OTHER = 'td-zzzzzzzz-abcdefghijkl';
const TMUX = '/usr/bin/tmux';
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

const line = (socket: string, created = '1700000000', activity = '1700000100', attached = '0') =>
  `${socket}\t${created}\t${activity}\t${attached}`;

describe('remote scan command (plan D-30)', () => {
  it('is one POSIX line without `!`, through remoteCommand, with numbers-only formats', () => {
    const command = scanSocketsCommand({ tmuxPath: TMUX });
    expect(command.startsWith('exec sh -c ')).toBe(true);
    expect(command).not.toMatch(/[\r\n]/);
    expect(command).not.toContain('!'); // csh history expansion
    expect(command).toContain('/tmux-$(id -u)');
    expect(command).toContain('td-*');
    // No session name, pane command or title leaves the host: numbers and a main flag only.
    expect(SCAN_SESSION_FORMAT).not.toMatch(/pane_|title|#\{session_name\}[^,]/);
    expect(SCAN_SESSION_FORMAT.split(' ')).toHaveLength(4);
    // Nothing is killed or removed by a scan.
    expect(command).not.toMatch(/kill|rm /);
    expect(() => scanSocketsCommand({ tmuxPath: 'tmux' })).toThrow(RangeError);
    expect(() => scanSocketsCommand({ tmuxPath: '/usr/bin/tmux;reboot' })).toThrow(RangeError);
  });

  it('checks a single socket with list-sessions and refuses unsafe names', () => {
    expect(serverAnswersCommand({ tmuxPath: TMUX, socket: own(TOKEN_A) })).toContain(
      `-L ${own(TOKEN_A)} list-sessions`,
    );
    expect(() => serverAnswersCommand({ tmuxPath: TMUX, socket: 'td-x y' })).toThrow(RangeError);
  });
});

describe('parseRemoteScan (untrusted host output)', () => {
  it('reads one entry per answering server, seconds to ms', () => {
    const scan = parseRemoteScan(
      [line(own(TOKEN_A)), line(OTHER, '1700000500', '1700000600', '2'), ''].join('\n'),
    );
    expect(scan).toEqual({
      truncated: false,
      entries: [
        {
          socket: own(TOKEN_A),
          createdAt: 1_700_000_000_000,
          lastActivityAt: 1_700_000_100_000,
          attachedClients: 0,
        },
        {
          socket: OTHER,
          createdAt: 1_700_000_500_000,
          lastActivityAt: 1_700_000_600_000,
          attachedClients: 2,
        },
      ],
    });
  });

  it('drops invalid names, wrong field counts, overlong lines, duplicates and noise', () => {
    const output = [
      'Welcome to the host!', // rc-file noise
      line('td-UPPER123-abcdefghijkl'),
      line('td-aaaa1111-abcdefghijk'), // token too short
      line('td-aaaa1111-abcdefghijk1'), // `1` is not base32
      line('td-123456789-abcdefghijkl'), // prefix too long
      line('xtd-aaaa1111-abcdefghijkl'),
      `${line(own(TOKEN_A))}\textra`,
      `${own(TOKEN_B)}\t1700000000`,
      `${line(own(TOKEN_C))}${' '.repeat(300)}`, // overlong: not what the script prints
      line(own(TOKEN_A)),
      line(own(TOKEN_A), '1', '2', '3'), // duplicate socket: the first one stands
      `${line(own(TOKEN_B))}\r`, // CRLF tolerated
    ].join('\n');
    expect(parseRemoteScan(output).entries.map((e) => [e.socket, e.attachedClients])).toEqual([
      [own(TOKEN_A), 0],
      [own(TOKEN_B), 0],
    ]);
  });

  it('parses numbers defensively: absent, zero or invalid times are null, a bad count is 0', () => {
    const scan = parseRemoteScan(
      [
        line(own(TOKEN_A), '', '', ''),
        line(own(TOKEN_B), '0', '-5', 'x'),
        line(own(TOKEN_C), '1e9', '9999999999999', '1234567'),
        line(OTHER, ' 1700000000', '1700000000.5', '07'),
      ].join('\n'),
    );
    expect(scan.entries.map((e) => [e.createdAt, e.lastActivityAt, e.attachedClients])).toEqual([
      [null, null, 0],
      [null, null, 0],
      [null, null, 0],
      [null, null, 7],
    ]);
  });

  it(`keeps at most ${REMOTE_SCAN_MAX_ENTRIES} entries and marks the cut`, () => {
    const base32 = 'abcdefghijklmnopqrstuvwxyz234567';
    const token = (i: number): string =>
      Array.from({ length: 12 }, (_, k) => base32[Math.floor(i / 32 ** k) % 32]).join('');
    const sockets = Array.from({ length: REMOTE_SCAN_MAX_ENTRIES + 1 }, (_, i) => own(token(i)));
    expect(new Set(sockets).size).toBe(REMOTE_SCAN_MAX_ENTRIES + 1);
    const full = parseRemoteScan(
      sockets
        .slice(0, -1)
        .map((s) => line(s))
        .join('\n'),
    );
    expect(full).toMatchObject({ truncated: false });
    expect(full.entries).toHaveLength(REMOTE_SCAN_MAX_ENTRIES);
    const over = parseRemoteScan(sockets.map((s) => line(s)).join('\n'));
    expect(over.truncated).toBe(true);
    expect(over.entries).toHaveLength(REMOTE_SCAN_MAX_ENTRIES);
  });

  it('a byte-capped output drops its partial last line and counts as truncated', () => {
    const scan = parseRemoteScan(`${line(own(TOKEN_A))}\n${line(own(TOKEN_B)).slice(0, 20)}`, true);
    expect(scan.truncated).toBe(true);
    expect(scan.entries.map((e) => e.socket)).toEqual([own(TOKEN_A)]);
  });
});

function owner(
  token: string,
  userId: string,
  state: SessionState,
  endedAt: number | null = null,
  socket = own(token),
): SocketOwner {
  return {
    sessionId: `s-${token}-${userId}`,
    userId,
    label: `label ${token}`,
    socket,
    state,
    endedAt,
  };
}

describe('classifySocket (plan D-30)', () => {
  const me = 'user-a';
  const them = 'user-b';

  it('running sessions of anyone and ended sessions of others are hidden; mine are leftovers', () => {
    const owners = [
      owner(TOKEN_A, me, 'ready'),
      owner(TOKEN_B, them, 'reconnecting'),
      owner(TOKEN_C, them, 'ended', 5),
    ];
    expect(classifySocket(own(TOKEN_A), owners, me, PREFIX)).toEqual({ kind: 'running' });
    expect(classifySocket(own(TOKEN_B), owners, me, PREFIX)).toEqual({ kind: 'running' });
    expect(classifySocket(own(TOKEN_C), owners, me, PREFIX)).toEqual({ kind: 'foreign' });
    const mine = owner(TOKEN_C, me, 'ended', 7);
    expect(classifySocket(own(TOKEN_C), [mine], me, PREFIX)).toEqual({
      kind: 'ended',
      owner: mine,
    });
    // `terminating` and `failed` are not ended: hidden.
    expect(classifySocket(own(TOKEN_C), [owner(TOKEN_C, me, 'terminating')], me, PREFIX)).toEqual({
      kind: 'running',
    });
    expect(classifySocket(own(TOKEN_C), [owner(TOKEN_C, me, 'failed')], me, PREFIX)).toEqual({
      kind: 'running',
    });
  });

  it('without a record: own prefix is unknown, any other prefix is other', () => {
    expect(classifySocket(own(TOKEN_A), [], me, PREFIX)).toEqual({ kind: 'unknown' });
    expect(classifySocket(OTHER, [], me, PREFIX)).toEqual({ kind: 'other' });
    // A prefix that merely starts like ours is another installation's.
    expect(classifySocket(`td-${PREFIX}x-${TOKEN_A}`, [], me, PREFIX)).toEqual({ kind: 'other' });
  });

  it('an adopted session claims its full socket name (`tmux_socket`), whatever the prefix', () => {
    const adopted = owner(TOKEN_A, me, 'ready', null, OTHER);
    expect(classifySocket(OTHER, [adopted], me, PREFIX)).toEqual({ kind: 'running' });
    const ended = owner(TOKEN_A, me, 'ended', 9, OTHER);
    expect(classifySocket(OTHER, [ended], me, PREFIX)).toEqual({ kind: 'ended', owner: ended });
  });

  it('precedence: anything running wins, then another user, then my latest end', () => {
    const mineEnded = owner(TOKEN_A, me, 'ended', 5);
    expect(
      classifySocket(own(TOKEN_A), [mineEnded, owner(TOKEN_A, them, 'ready')], me, PREFIX),
    ).toEqual({ kind: 'running' });
    expect(
      classifySocket(own(TOKEN_A), [mineEnded, owner(TOKEN_A, them, 'ended', 1)], me, PREFIX),
    ).toEqual({ kind: 'foreign' });
    const later = { ...owner(TOKEN_A, me, 'ended', 50), sessionId: 'later' };
    expect(classifySocket(own(TOKEN_A), [mineEnded, later], me, PREFIX)).toEqual({
      kind: 'ended',
      owner: later,
    });
  });
});

/** In-memory socket owners plus the events recorded on them. */
class MemoryLookup implements RemoteSessionLookup {
  owners: SocketOwner[] = [];
  readonly events: Array<SessionEventInput & { sessionId: string }> = [];
  readonly servers = new Map<string, string>([['server-1', 'web box']]);
  lookups = 0;

  async socketOwners(sockets: readonly string[]): Promise<SocketOwner[]> {
    this.lookups++;
    return this.owners.filter((o) => sockets.includes(o.socket)).map((o) => ({ ...o }));
  }

  async serverName(serverId: string): Promise<string | null> {
    return this.servers.get(serverId) ?? null;
  }

  appendEvent(sessionId: string, event: SessionEventInput): void {
    this.events.push({ sessionId, ...event });
  }
}

/** A connected fake transport answering the scan and kill commands. */
function hostWith(
  scan: string,
  kill: (socket: string) => FakeExecResult = () => ({ code: 0 }),
): { transport: FakeTransport; killed: string[] } {
  const killed: string[] = [];
  const transport = new FakeTransport(
    { onHostKey: () => {}, onKeyboardInteractive: async () => null },
    {
      exec: (command) => {
        if (command === scanSocketsCommand({ tmuxPath: TMUX })) return { stdout: scan };
        const socket = /s=(td-[a-z0-9-]+);/.exec(command)?.[1];
        if (socket && command === killServerCommand({ tmuxPath: TMUX, socket })) {
          killed.push(socket);
          return kill(socket);
        }
        return { code: 127 };
      },
    },
  );
  return { transport, killed };
}

describe('endLeftovers: re-checked right before each kill, never within 60 s of the end', () => {
  const me = 'user-a';
  const NOW = 10_000_000;

  it('kills a leftover ended long enough ago, records remote_cleanup, skips a recent one', async () => {
    const lookup = new MemoryLookup();
    const old = owner(TOKEN_A, me, 'ended', NOW - ENDED_GUARD_MS - 1);
    const recent = owner(TOKEN_B, me, 'ended', NOW - ENDED_GUARD_MS + 1_000);
    lookup.owners = [old, recent];
    const { transport, killed } = hostWith('');
    const entry = (socket: string) => ({
      socket,
      createdAt: null,
      lastActivityAt: null,
      attachedClients: 0,
    });
    const result = await endLeftovers({
      transport,
      tmuxPath: TMUX,
      leftovers: [
        { entry: entry(old.socket), owner: old },
        { entry: entry(recent.socket), owner: recent },
      ],
      lookup,
      actingUserId: me,
      ownPrefix: PREFIX,
      source: 'sweep',
      now: () => NOW,
    });
    expect(result).toEqual({ cleaned: 1, failed: [] });
    expect(killed).toEqual([old.socket]);
    expect(lookup.events).toEqual([
      { sessionId: old.sessionId, type: 'remote_cleanup', detail: { source: 'sweep' } },
    ]);
  });

  it('skips a socket that was reopened or adopted since the scan; reports a failed kill', async () => {
    const lookup = new MemoryLookup();
    const reopened = owner(TOKEN_A, me, 'ended', 1);
    const failing = owner(TOKEN_B, me, 'ended', 1);
    // After the scan: TOKEN_A's session was reopened (no longer ended).
    lookup.owners = [{ ...reopened, state: 'new', endedAt: null }, failing];
    const { transport, killed } = hostWith('', () => ({ code: 1 }));
    const entry = (socket: string) => ({
      socket,
      createdAt: null,
      lastActivityAt: null,
      attachedClients: 1,
    });
    const result = await endLeftovers({
      transport,
      tmuxPath: TMUX,
      leftovers: [
        { entry: entry(reopened.socket), owner: reopened },
        { entry: entry(failing.socket), owner: failing },
      ],
      lookup,
      actingUserId: me,
      ownPrefix: PREFIX,
      source: 'scan',
      now: () => NOW,
    });
    expect(killed).toEqual([failing.socket]);
    expect(result.cleaned).toBe(0);
    expect(result.failed.map((f) => f.owner.sessionId)).toEqual([failing.sessionId]);
    expect(lookup.events).toEqual([]);
  });

  it('a passed deadline leaves the rest listed as not ended, without killing', async () => {
    const lookup = new MemoryLookup();
    const left = owner(TOKEN_A, me, 'ended', 1);
    lookup.owners = [left];
    const { transport, killed } = hostWith('');
    const result = await endLeftovers({
      transport,
      tmuxPath: TMUX,
      leftovers: [
        {
          entry: { socket: left.socket, createdAt: null, lastActivityAt: null, attachedClients: 0 },
          owner: left,
        },
      ],
      lookup,
      actingUserId: me,
      ownPrefix: PREFIX,
      source: 'scan',
      now: () => NOW,
      deadline: NOW,
    });
    expect(killed).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });
});

describe('RemoteSweeper (background sweep after ready)', () => {
  const me = 'user-a';
  const target = {
    userId: me,
    serverId: 'server-1',
    hostname: 'Web.Example',
    port: 22,
    username: 'deploy',
  };

  function sweeper(lookup: MemoryLookup, clock: { now: number }) {
    const notifier = new RecordingNotifier();
    const instance = new RemoteSweeper({
      lookup,
      notifier,
      installationId: `${PREFIX}-0000-7000-8000-000000000000`,
      now: () => clock.now,
    });
    return { instance, notifier };
  }

  it('ends my leftovers, hides running and foreign servers, tells me about unknown ones once', async () => {
    const lookup = new MemoryLookup();
    const clock = { now: 50_000_000 };
    lookup.owners = [
      owner(TOKEN_A, me, 'ended', 1), // leftover: ended at once
      owner(TOKEN_B, 'user-b', 'ready'), // another user's running session: hidden
    ];
    const scan = [line(own(TOKEN_A)), line(own(TOKEN_B)), line(own(TOKEN_C)), line(OTHER)].join(
      '\n',
    );
    const { instance, notifier } = sweeper(lookup, clock);
    const host = hostWith(scan);
    await instance.sweep(target, host.transport, TMUX, () => true);
    expect(host.killed).toEqual([own(TOKEN_A)]);
    expect(notifier.messages).toEqual([
      {
        userId: me,
        message: {
          type: 'server.remote_sessions',
          serverId: 'server-1',
          serverName: 'web box',
          count: 2,
        },
      },
    ]);

    // Rate limit: the same user, address (any case) and user name within 15 min do not sweep.
    const again = hostWith(scan);
    expect(
      instance.sweep({ ...target, hostname: 'web.example' }, again.transport, TMUX, () => true),
    ).toBeNull();
    expect(again.transport.commands).toEqual([]);
    // Another user name on the same address is another sweep; the same unknown set is not told
    // again in this daemon run.
    const other = hostWith(scan);
    await instance.sweep({ ...target, username: 'root' }, other.transport, TMUX, () => true);
    expect(other.transport.commands).toHaveLength(2); // the scan, then the (re-checked) leftover
    expect(notifier.messages).toHaveLength(1);

    // After 15 min it sweeps again; a changed set of unknown servers is told again.
    clock.now += SWEEP_INTERVAL_MS;
    const later = hostWith([line(own(TOKEN_C))].join('\n'));
    await instance.sweep(target, later.transport, TMUX, () => true);
    expect(later.transport.commands).toEqual([scanSocketsCommand({ tmuxPath: TMUX })]);
    expect(notifier.messages.map((m) => m.message)).toEqual([
      expect.objectContaining({ count: 2 }),
      expect.objectContaining({ type: 'server.remote_sessions', count: 1 }),
    ]);
  });

  it('only hidden servers: no notice; a stale attempt stops before classifying', async () => {
    const lookup = new MemoryLookup();
    lookup.owners = [owner(TOKEN_A, me, 'ready')];
    const { instance, notifier } = sweeper(lookup, { now: 1 });
    await instance.sweep(target, hostWith(line(own(TOKEN_A))).transport, TMUX, () => true);
    expect(notifier.messages).toEqual([]);

    const stale = new MemoryLookup();
    const second = sweeper(stale, { now: 1 });
    await second.instance.sweep(target, hostWith(line(OTHER)).transport, TMUX, () => false);
    expect(stale.lookups).toBe(0);
    expect(second.notifier.messages).toEqual([]);
  });

  it(`remembers at most ${NOTIFIED_MAX} notices, forgetting the oldest first`, async () => {
    // A token per number, in the socket name alphabet (base 32).
    const token = (n: number) =>
      n
        .toString(32)
        .padStart(12, '0')
        .replace(/[0-9a-v]/g, (c) => B32[Number.parseInt(c, 32)]!);
    const clock = { now: 1 };
    const sweepOnce = async (instance: RemoteSweeper, sockets: string[]) => {
      clock.now += SWEEP_INTERVAL_MS; // past the rate limit of the target
      await instance.sweep(
        target,
        hostWith(sockets.map((s) => line(s)).join('\n')).transport,
        TMUX,
        () => true,
      );
    };

    const { instance, notifier } = sweeper(new MemoryLookup(), clock);
    for (let n = 0; n < NOTIFIED_MAX + 50; n++) await sweepOnce(instance, [own(token(n))]);
    expect(notifier.messages).toHaveLength(NOTIFIED_MAX + 50);
    expect(instance.notifiedCount).toBe(NOTIFIED_MAX);

    const small = new RemoteSweeper({
      lookup: new MemoryLookup(),
      notifier,
      installationId: `${PREFIX}-0000-7000-8000-000000000000`,
      now: () => clock.now,
      notifiedMax: 2,
    });
    notifier.messages.length = 0;
    const sets = [[own(TOKEN_A)], [own(TOKEN_B)], [own(TOKEN_A), own(TOKEN_C)]];
    for (const set of sets) await sweepOnce(small, set);
    expect(small.notifiedCount).toBe(2);
    // The last two sets are still remembered; the oldest was forgotten and is told again.
    await sweepOnce(small, [own(TOKEN_C), own(TOKEN_A)]);
    await sweepOnce(small, [own(TOKEN_B)]);
    expect(notifier.messages).toHaveLength(3);
    await sweepOnce(small, [own(TOKEN_A)]);
    expect(notifier.messages.map((m) => m.message)).toEqual([
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ count: 1 }),
      expect.objectContaining({ count: 2 }),
      expect.objectContaining({ count: 1 }),
    ]);
    expect(small.notifiedCount).toBe(2);
  });

  it('never rejects: a failing scan is only logged', async () => {
    const { instance, notifier } = sweeper(new MemoryLookup(), { now: 1 });
    const broken = new FakeTransport(
      { onHostKey: () => {}, onKeyboardInteractive: async () => null },
      {
        exec: () => {
          throw new Error('channel refused');
        },
      },
    );
    await expect(instance.sweep(target, broken, TMUX, () => true)).resolves.toBeUndefined();
    expect(notifier.messages).toEqual([]);
  });
});
