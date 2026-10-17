/**
 * Remote tmux leftovers (plan D-30, §6.12): the scan of a host's Termdock tmux servers and its
 * strict parser, the classification of what it found against the session records, ending the
 * leftovers of sessions the user already ended, and the background sweep a session runs on its
 * own connection once it is ready.
 *
 * Everything read from the host is untrusted (§10.2): the scan reports numbers only (no pane
 * command, title or session name), lines are capped, and a socket name that is not exactly
 * `td-<prefix>-<token>` is dropped. A session that runs in Termdock (any user), and every ended
 * session of another user, is never listed, ended or adopted.
 */
import { REMOTE_SOCKET_PATTERN } from '@termdock/protocol';
import { ErrorCode, normalizeHostname } from '@termdock/shared';
import { type Logger, silentLogger } from '../config/logger.ts';
import {
  killServerCommand,
  SCAN_MAX_SERVERS,
  scanSocketsCommand,
  serverAnswersCommand,
} from '../drivers/tmux-control/commands.ts';
import { tmuxSocketPrefix } from './driver-factory.ts';
import type { UserNotifier } from './session-runtime.ts';
import {
  type ExecChannel,
  type RemoteSessionLookup,
  type SocketOwner,
  type Transport,
  TransportError,
} from './types.ts';

/** Scan output read at most (UTF-8 bytes); beyond it the scan counts as truncated. */
export const REMOTE_SCAN_MAX_BYTES = 64 * 1024;
/** A longer scan line is not one the script printed: dropped. */
export const REMOTE_SCAN_MAX_LINE = 256;
/** Entries kept from one scan; one more marks the result `truncated`. */
export const REMOTE_SCAN_MAX_ENTRIES = SCAN_MAX_SERVERS;
/**
 * A session ended this recently keeps its tmux for now: Reopen keeps the tmux token, and
 * `new-session -A` would reattach a surviving server, so ending it could kill a reopened shell.
 */
export const ENDED_GUARD_MS = 60_000;
/** One background sweep per (user, address, user name on the server) and process in this time. */
export const SWEEP_INTERVAL_MS = 15 * 60_000;
export const SCAN_TIMEOUT_MS = 10_000;
/** `killServerCommand` waits up to ~1 s for tmux processes; the exec gets some slack. */
export const KILL_TIMEOUT_MS = 5_000;

/** One tmux server the scan found. Times are epoch ms; null when tmux did not report one. */
export interface RemoteScanEntry {
  socket: string;
  createdAt: number | null;
  lastActivityAt: number | null;
  attachedClients: number;
}

export interface RemoteScan {
  entries: RemoteScanEntry[];
  /** More servers than REMOTE_SCAN_MAX_ENTRIES, or more output than REMOTE_SCAN_MAX_BYTES. */
  truncated: boolean;
}

const SECONDS = /^\d{1,12}$/;
const COUNT = /^\d{1,6}$/;

function epochMs(field: string | undefined): number | null {
  if (field === undefined || !SECONDS.test(field)) return null;
  const seconds = Number(field);
  return seconds > 0 ? seconds * 1000 : null;
}

/**
 * Parses the output of `scanSocketsCommand` (untrusted host output). A line is kept only when it
 * has exactly the four tab-separated fields, a socket name matching REMOTE_SOCKET_PATTERN not seen
 * before, and fits REMOTE_SCAN_MAX_LINE; anything else (e.g. noise from a login shell's rc file)
 * is dropped. Times are seconds → ms (null when absent, zero or not a number); an unreadable
 * client count is 0. `cut`: the reader stopped at its byte cap, so the last line may be partial.
 */
export function parseRemoteScan(output: string, cut = false): RemoteScan {
  const entries: RemoteScanEntry[] = [];
  const seen = new Set<string>();
  let truncated = cut;
  const lines = output.split('\n');
  if (cut) lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0 || line.length > REMOTE_SCAN_MAX_LINE) continue;
    const fields = line.split('\t');
    if (fields.length !== 4) continue;
    const [socket, created, activity, attached] = fields as [string, string, string, string];
    if (!REMOTE_SOCKET_PATTERN.test(socket) || seen.has(socket)) continue;
    if (entries.length >= REMOTE_SCAN_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    seen.add(socket);
    entries.push({
      socket,
      createdAt: epochMs(created),
      lastActivityAt: epochMs(activity),
      attachedClients: COUNT.test(attached) ? Number(attached) : 0,
    });
  }
  return { entries, truncated };
}

interface RemoteRun {
  stdout: Buffer;
  code: number | null;
  /** stdout went past `maxBytes`: the channel was closed there. */
  cut: boolean;
}

/**
 * Runs one remote command over an exec channel without a PTY: stdout is kept up to `maxBytes`
 * (0: discarded), stderr is drained and discarded. `timeoutMs` bounds everything from opening
 * the channel on: then the channel is closed and the call fails with a retryable TransportError
 * carrying `timeoutCode`.
 */
async function runRemote(
  transport: Transport,
  command: string,
  opts: { timeoutMs: number; maxBytes?: number; timeoutCode: string },
): Promise<RemoteRun> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TransportError(opts.timeoutCode, 'remote command timed out', true)),
      opts.timeoutMs,
    );
  });
  timeout.catch(() => {});
  const opening = transport.exec(command);
  let channel: ExecChannel;
  try {
    channel = await Promise.race([opening, timeout]);
  } catch (err) {
    clearTimeout(timer);
    // A channel that opens after the deadline is closed at once.
    opening.then(closeChannel, () => {});
    throw err;
  }
  channel.end();
  const maxBytes = opts.maxBytes ?? 0;
  const parts: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  const readStdout = async (): Promise<void> => {
    for await (const part of channel.stdout) {
      if (size + part.byteLength > maxBytes) {
        if (maxBytes === 0) continue;
        parts.push(part.subarray(0, maxBytes - size));
        size = maxBytes;
        cut = true;
        closeChannel(channel);
        return;
      }
      parts.push(part);
      size += part.byteLength;
    }
  };
  const drain = async (stream: AsyncIterable<Uint8Array>): Promise<void> => {
    for await (const _part of stream) {
      // discarded
    }
  };
  try {
    const [, , exit] = await Promise.race([
      Promise.all([readStdout(), drain(channel.stderr), channel.exit]),
      timeout,
    ]);
    return { stdout: Buffer.concat(parts), code: cut ? null : exit.code, cut };
  } catch (err) {
    closeChannel(channel);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function closeChannel(channel: ExecChannel): void {
  try {
    if (channel.close) channel.close();
    else channel.end();
  } catch {
    // Already closed.
  }
}

/** Lists this user's Termdock tmux servers on the host (plan D-30). */
export async function runRemoteScan(
  transport: Transport,
  tmuxPath: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<RemoteScan> {
  const run = await runRemote(transport, scanSocketsCommand({ tmuxPath }), {
    timeoutMs: opts.timeoutMs ?? SCAN_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? REMOTE_SCAN_MAX_BYTES,
    timeoutCode: 'SCAN_TIMEOUT',
  });
  return parseRemoteScan(run.stdout.toString('utf8'), run.cut);
}

/** Whether the tmux server of `socket` answers. */
export async function remoteServerAnswers(
  transport: Transport,
  tmuxPath: string,
  socket: string,
  timeoutMs = KILL_TIMEOUT_MS,
): Promise<boolean> {
  const run = await runRemote(transport, serverAnswersCommand({ tmuxPath, socket }), {
    timeoutMs,
    timeoutCode: 'REMOTE_TIMEOUT',
  });
  return run.code === 0;
}

/**
 * Ends the tmux server of `socket` and the processes that keep it alive (`killServerCommand`,
 * the same command a live terminate runs). Fails unless the command ran to its end.
 */
export async function endRemoteServer(
  transport: Transport,
  tmuxPath: string,
  socket: string,
  timeoutMs = KILL_TIMEOUT_MS,
): Promise<void> {
  const run = await runRemote(transport, killServerCommand({ tmuxPath, socket }), {
    timeoutMs,
    timeoutCode: 'REMOTE_TIMEOUT',
  });
  if (run.code !== 0) {
    throw new TransportError(ErrorCode.ChannelFailed, `kill-server exited with ${run.code}`, true);
  }
}

/**
 * What a remote tmux server is to the acting user (plan D-30), checked in this order:
 * - `running`: it belongs to a session that is not ended, of any user: hidden, never touched;
 * - `foreign`: it belongs to an ended session of another user: hidden, never touched;
 * - `ended`: it belongs to an ended session of the acting user: a leftover, ended at once;
 * - `unknown`: this installation's prefix, but no session record has it;
 * - `other`: another prefix (another installation, or this one before a database reset).
 */
export type SocketClass =
  | { kind: 'running' }
  | { kind: 'foreign' }
  | { kind: 'ended'; owner: SocketOwner }
  | { kind: 'unknown' }
  | { kind: 'other' };

export function classifySocket(
  socket: string,
  owners: readonly SocketOwner[],
  actingUserId: string,
  ownPrefix: string,
): SocketClass {
  const claims = owners.filter((o) => o.socket === socket);
  if (claims.some((o) => o.state !== 'ended')) return { kind: 'running' };
  if (claims.some((o) => o.userId !== actingUserId)) return { kind: 'foreign' };
  // Several ended sessions of the user on one socket: the latest end decides (the 60 s guard).
  const owner = claims.reduce<SocketOwner | null>(
    (latest, o) => (latest === null || (o.endedAt ?? 0) > (latest.endedAt ?? 0) ? o : latest),
    null,
  );
  if (owner) return { kind: 'ended', owner };
  return socket.startsWith(`td-${ownPrefix}-`) ? { kind: 'unknown' } : { kind: 'other' };
}

/** A leftover the scan found: the tmux server of an ended session of the acting user. */
export interface Leftover {
  entry: RemoteScanEntry;
  owner: SocketOwner;
}

export interface EndLeftoversInput {
  transport: Transport;
  tmuxPath: string;
  leftovers: readonly Leftover[];
  lookup: RemoteSessionLookup;
  actingUserId: string;
  ownPrefix: string;
  /** Recorded on the ended session's `remote_cleanup` event. */
  source: 'sweep' | 'scan';
  now?: () => number;
  /** Epoch ms: a leftover not reached by then counts as not ended. */
  deadline?: number;
  killTimeoutMs?: number;
  /** False once the connection is no longer the one to use (the sweep's attempt ended). */
  live?: () => boolean;
}

/**
 * Ends leftovers one by one. Right before each kill the socket is classified again (writes still
 * queued included) and skipped unless it still belongs only to an ended session of the acting
 * user that ended at least ENDED_GUARD_MS ago: a Reopen or an adoption in between wins. A kill
 * that fails, or that the deadline leaves out, is returned in `failed`; a skipped one in neither.
 */
export async function endLeftovers(
  input: EndLeftoversInput,
): Promise<{ cleaned: number; failed: Leftover[] }> {
  const now = input.now ?? Date.now;
  const live = input.live ?? (() => true);
  const failed: Leftover[] = [];
  let cleaned = 0;
  for (const leftover of input.leftovers) {
    if (!live()) break;
    const { socket } = leftover.entry;
    const left = input.deadline === undefined ? Number.POSITIVE_INFINITY : input.deadline - now();
    if (left <= 0) {
      failed.push(leftover);
      continue;
    }
    const owners = await input.lookup.socketOwners([socket], input.ownPrefix);
    const current = classifySocket(socket, owners, input.actingUserId, input.ownPrefix);
    if (current.kind !== 'ended') continue;
    const { endedAt } = current.owner;
    if (endedAt === null || now() - endedAt < ENDED_GUARD_MS) continue;
    try {
      await endRemoteServer(
        input.transport,
        input.tmuxPath,
        socket,
        Math.min(input.killTimeoutMs ?? KILL_TIMEOUT_MS, left),
      );
    } catch {
      failed.push({ entry: leftover.entry, owner: current.owner });
      continue;
    }
    cleaned++;
    input.lookup.appendEvent(current.owner.sessionId, {
      type: 'remote_cleanup',
      detail: { source: input.source },
    });
  }
  return { cleaned, failed };
}

/** The session whose connection sweeps: its owner, server and snapshotted address. */
export interface SweepTarget {
  userId: string;
  serverId: string;
  hostname: string;
  port: number;
  username: string;
}

export interface RemoteSweeperOptions {
  lookup: RemoteSessionLookup;
  notifier: UserNotifier;
  installationId: string;
  logger?: Logger;
  now?: () => number;
  intervalMs?: number;
  scanTimeoutMs?: number;
  killTimeoutMs?: number;
}

/**
 * The background sweep (plan D-30): once a session is ready, its own connection lists the user's
 * Termdock tmux servers on the host, ends the leftovers of sessions the user already ended, and
 * tells the user (`server.remote_sessions`) about servers no session record knows. At most once
 * per (user, address, user name) every SWEEP_INTERVAL_MS per process; the notice at most once per
 * daemon run per server and set of sockets. Detached from the session: it never delays or fails
 * it, and its errors are only logged.
 */
export class RemoteSweeper {
  readonly #lookup: RemoteSessionLookup;
  readonly #notifier: UserNotifier;
  readonly #prefix: string;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #scanTimeoutMs: number;
  readonly #killTimeoutMs: number;
  /** Last sweep start per (user, address, user name). */
  readonly #lastSweep = new Map<string, number>();
  /** (server, sorted sockets) already told to its owner in this daemon run. */
  readonly #notified = new Set<string>();

  constructor(options: RemoteSweeperOptions) {
    this.#lookup = options.lookup;
    this.#notifier = options.notifier;
    this.#prefix = tmuxSocketPrefix(options.installationId);
    this.#log = (options.logger ?? silentLogger()).child({ component: 'remote-sweep' });
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
    this.#scanTimeoutMs = options.scanTimeoutMs ?? SCAN_TIMEOUT_MS;
    this.#killTimeoutMs = options.killTimeoutMs ?? KILL_TIMEOUT_MS;
  }

  /**
   * Starts a sweep over `transport` unless this target was swept within the interval. Returns the
   * running sweep (it never rejects), or null when rate-limited.
   */
  sweep(
    target: SweepTarget,
    transport: Transport,
    tmuxPath: string,
    live: () => boolean,
  ): Promise<void> | null {
    const key = [
      target.userId,
      normalizeHostname(target.hostname),
      target.port,
      target.username,
    ].join('\u0000');
    const now = this.#now();
    const last = this.#lastSweep.get(key);
    if (last !== undefined && now - last < this.#intervalMs) return null;
    if (this.#lastSweep.size > 1024) {
      for (const [k, at] of this.#lastSweep) {
        if (now - at >= this.#intervalMs) this.#lastSweep.delete(k);
      }
    }
    this.#lastSweep.set(key, now);
    return this.#run(target, transport, tmuxPath, live).catch((err: unknown) => {
      this.#log.info(
        { serverId: target.serverId, err: describeError(err) },
        'remote tmux sweep failed',
      );
    });
  }

  async #run(
    target: SweepTarget,
    transport: Transport,
    tmuxPath: string,
    live: () => boolean,
  ): Promise<void> {
    const scan = await runRemoteScan(transport, tmuxPath, { timeoutMs: this.#scanTimeoutMs });
    if (!live() || scan.entries.length === 0) return;
    const owners = await this.#lookup.socketOwners(
      scan.entries.map((e) => e.socket),
      this.#prefix,
    );
    const leftovers: Leftover[] = [];
    const unknown: string[] = [];
    for (const entry of scan.entries) {
      const found = classifySocket(entry.socket, owners, target.userId, this.#prefix);
      if (found.kind === 'ended') leftovers.push({ entry, owner: found.owner });
      else if (found.kind === 'unknown' || found.kind === 'other') unknown.push(entry.socket);
    }
    if (leftovers.length > 0) {
      const { cleaned, failed } = await endLeftovers({
        transport,
        tmuxPath,
        leftovers,
        lookup: this.#lookup,
        actingUserId: target.userId,
        ownPrefix: this.#prefix,
        source: 'sweep',
        now: this.#now,
        killTimeoutMs: this.#killTimeoutMs,
        live,
      });
      if (cleaned > 0 || failed.length > 0) {
        this.#log.info(
          { serverId: target.serverId, cleaned, failed: failed.length },
          'ended remote tmux leftovers of ended sessions',
        );
      }
    }
    if (unknown.length === 0) return;
    const key = `${target.serverId}\u0000${unknown.sort().join(',')}`;
    if (this.#notified.has(key)) return;
    const serverName = await this.#lookup.serverName(target.serverId);
    if (serverName === null) return;
    this.#notified.add(key);
    this.#notifier.sendToUser(target.userId, {
      type: 'server.remote_sessions',
      serverId: target.serverId,
      serverName,
      count: unknown.length,
    });
  }
}

function describeError(err: unknown): { code?: string; message: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { ...(typeof code === 'string' ? { code } : {}), message: err.message };
  }
  return { message: String(err) };
}
