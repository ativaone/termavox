/**
 * TmuxControlDriver (plan §5.2, §6; ADR-0002, ADR-0003): drives a per-session tmux server in
 * control mode over a PTY-less SSH exec channel. tmux keeps the session alive across daemon
 * restarts and network drops; on every (re)attach the emulator is rebuilt from `capture-pane`.
 */
import type {
  Dimensions,
  Driver,
  DriverContext,
  ExecChannel,
  RemoteIdentity,
  Transport,
} from '../../core/types.ts';
import type { ProbeResult } from '../../probe/index.ts';
import { OutputGate, type StreamEvent } from './boundary.ts';
import {
  confirmEndedCommand,
  detachClient,
  displayFormat,
  killServer,
  killServerCommand,
  type LaunchOptions,
  type ListedClient,
  launchCommand,
  launchCommands,
  listClients,
  parseListedClient,
  recoverSocketCommand,
  refreshClientContinue,
  refreshClientPauseAfter,
  refreshClientSize,
  SESSION_CREATED_MARKER,
  sendKeysCancel,
} from './commands.ts';
import {
  type BatchResult,
  CommandCorrelator,
  type CommandResult,
  TmuxDesyncError,
} from './correlator.ts';
import { encodeInput, MAX_INPUT_BYTES_PER_COMMAND } from './input.ts';
import { concatBytes, LineSplitter } from './lines.ts';
import { type ControlEvent, ControlParser, paneSizeFromLayout } from './parser.ts';
import { type PaneCapture, parseCapture, rebuild, snapshotCommands } from './rebuild.ts';

export interface TmuxControlDriverOptions {
  /** tmuxPath, utf8Locale, tiTmux256, systemdRun, killUserProcesses, linger, shell. */
  probe: ProbeResult;
  /** e.g. td-<installationId[0:8]>-<tmuxToken>. */
  socket: string;
  /** history-limit and emulator scrollback. */
  scrollbackLines: number;
  startupCommand: string | null;
  env: Record<string, string>;
  previousIdentity: RemoteIdentity | null;
  /**
   * Called after every (re)attach with the observed identity; `rebooted` = previous identity
   * existed and differs; `created` = the launch created the session (an adopted session's tmux
   * was gone, plan D-30).
   */
  onIdentity(identity: RemoteIdentity, rebooted: boolean, created?: boolean): void;
  /** Default 5. */
  pauseAfterSeconds?: number;
}

export interface RebuildTiming {
  reason: string;
  /** Snapshot batch round trip (written → sentinel). */
  captureMs: number;
  /** `replaceState` duration (rebuild bytes parsed by the fresh emulator). */
  buildMs: number;
  historyLines: number;
  /** Bytes written into the fresh emulator. */
  bytes: number;
}

/** Diagnostics (not part of the Driver contract). */
export interface TmuxControlDriverStats {
  /** Whether the launch created the session (null before the launch completed). */
  created: boolean | null;
  /** Reattaches whose server answered again after SIGUSR1 recreated its deleted socket. */
  socketRecoveries: number;
  staleClientsDetached: number;
  rebuilds: number;
  /** `%pause` notifications for our pane. */
  pauses: number;
  /** stdout bytes read from the control channel. */
  receivedBytes: number;
  /** Pane output dropped because a capture contained it. */
  droppedBytes: number;
  /** Pane output received after a capture and applied after the rebuild. */
  heldBytes: number;
  /** Pane output received inside a snapshot reply (should stay 0; forces a retake). */
  boundaryViolations: number;
  /** Highest `%extended-output` age seen (tmux's own lag for this client). */
  maxOutputAgeMs: number;
  lastRebuild: RebuildTiming | null;
}

type Phase = 'idle' | 'starting' | 'running' | 'detaching' | 'terminating' | 'closed';

const INPUT_COALESCE_MS = 3;
/** Output held during a rebuild beyond this pauses reading the channel until the rebuild ends. */
const HOLD_LIMIT_BYTES = 8 * 1024 * 1024;
const CLOSE_TIMEOUT_MS = 3_000;
/** Remote cleanup scripts wait up to ~2 s for tmux processes; the exec gets some slack. */
const REAP_TIMEOUT_MS = 5_000;
const SNAPSHOT_ATTEMPTS = 3;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: Error): void;
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  promise.catch(() => {}); // rejections are observed by whoever awaits
  return {
    promise,
    resolve: (value) => {
      if (!settled) {
        settled = true;
        resolveFn(value);
      }
    },
    reject: (err) => {
      if (!settled) {
        settled = true;
        rejectFn(err);
      }
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const text = (lines: readonly Uint8Array[]): string =>
  lines.map((l) => decoder.decode(l)).join('\n');

/** csh/tcsh reject `-lc` (ADR-0002): their startup command is typed into the login shell. */
export function isCshFamily(shell: string | null): boolean {
  return /(^|\/)t?csh$/.test(shell ?? '');
}

/**
 * plan §5.11 logind rules. `systemdRun`: launch through `systemd-run --user --scope` so tmux
 * leaves our login session's scope. `survivesLogout`: false when logind kills user processes and
 * nothing protects tmux (the UI must warn: "remote may kill tmux on disconnect — enable linger").
 */
export function logindPolicy(probe: ProbeResult): { systemdRun: boolean; survivesLogout: boolean } {
  if (probe.killUserProcesses !== 'yes') return { systemdRun: false, survivesLogout: true };
  const systemdRun = probe.linger === 'yes' && probe.systemdRun;
  return { systemdRun, survivesLogout: systemdRun };
}

/** Runs a remote command to completion and returns its exit code. */
async function exitCodeOf(transport: Transport, command: string): Promise<number | null> {
  const channel = await transport.exec(command);
  channel.end();
  const drain = async (stream: AsyncIterable<Uint8Array>): Promise<void> => {
    for await (const _chunk of stream) {
      // discard
    }
  };
  const [, , result] = await Promise.all([
    drain(channel.stdout),
    drain(channel.stderr),
    channel.exit,
  ]);
  return result.code;
}

export class TmuxControlDriver implements Driver {
  readonly protection = 'tmux-control' as const;
  readonly #opts: TmuxControlDriverOptions;
  readonly #parser = new ControlParser();
  readonly #gate = new OutputGate('armed');
  #ctx: DriverContext | null = null;
  #channel: ExecChannel | null = null;
  #correlator: CommandCorrelator | null = null;
  #phase: Phase = 'idle';
  /** Flags-0 blocks expected from the launch argv, and seen so far. */
  #launchBlocks = 0;
  #launchSeen = 0;
  #launch: Deferred<boolean> | null = null;
  /** The launch's last block ended successfully: our session existed during this start. */
  #launched = false;
  #exitWaiter: Deferred<void> | null = null;
  /** has-session confirmation after %exit or an unexpected channel close (plan §6.10). */
  #exitConfirmation: Promise<void> | null = null;
  #channelDone = false;
  #paneId: number | null = null;
  #windowId: number | null = null;
  #reportedSize: Dimensions | null = null;
  #paneInMode = false;
  /** Pane output to deliver at the end of the current stdout chunk (one ctx.output per chunk). */
  #forward: Uint8Array[] = [];
  #input: Uint8Array[] = [];
  #inputBytes = 0;
  #inputTimer: NodeJS.Timeout | null = null;
  #deferredResize: Dimensions | null = null;
  /** Why reading the control channel is paused: the runtime's backpressure, a long rebuild. */
  readonly #pausedBy = new Set<'runtime' | 'rebuild'>();
  #readResume: Deferred<void> | null = null;
  #heldBytes = 0;
  #resyncChain: Promise<void> = Promise.resolve();
  #resyncQueued: { reason: string; continuePane: number | null; run: Promise<void> } | null = null;
  #stderr = '';
  readonly #stats: Omit<
    TmuxControlDriverStats,
    'droppedBytes' | 'heldBytes' | 'boundaryViolations'
  > = {
    created: null,
    socketRecoveries: 0,
    staleClientsDetached: 0,
    rebuilds: 0,
    pauses: 0,
    receivedBytes: 0,
    maxOutputAgeMs: 0,
    lastRebuild: null,
  };

  constructor(opts: TmuxControlDriverOptions) {
    this.#opts = opts;
  }

  get stats(): TmuxControlDriverStats {
    const gate = this.#gate.stats;
    return {
      ...this.#stats,
      droppedBytes: gate.droppedBytes,
      heldBytes: gate.heldBytes,
      boundaryViolations: gate.violations,
    };
  }

  async start(ctx: DriverContext, dims: Dimensions): Promise<void> {
    if (this.#phase !== 'idle')
      throw new Error(`TmuxControlDriver.start() in phase ${this.#phase}`);
    const { probe } = this.#opts;
    if (!probe.tmuxPath || !probe.utf8Locale) {
      throw new Error('tmux-control needs a tmux binary and a UTF-8 locale (probe)');
    }
    this.#phase = 'starting';
    this.#ctx = ctx;
    this.#reportedSize = { cols: dims.cols, rows: dims.rows };
    const typedStartup =
      isCshFamily(probe.shell) && this.#opts.startupCommand ? this.#opts.startupCommand : null;
    const launch: LaunchOptions = {
      tmuxPath: probe.tmuxPath,
      socket: this.#opts.socket,
      locale: probe.utf8Locale,
      historyLimit: this.#opts.scrollbackLines,
      defaultTerminal: probe.tiTmux256 ? 'tmux-256color' : 'screen-256color',
      cols: dims.cols,
      rows: dims.rows,
      env: this.#opts.env,
      startupCommand: typedStartup ? null : this.#opts.startupCommand,
      systemdRun: logindPolicy(probe).systemdRun,
    };
    this.#launch = deferred<boolean>();
    try {
      // Built (and so validated) before any remote exec: a value the builders refuse
      // (BadLaunchParamsError) rejects here, through the same cleanup as any failed start.
      const command = launchCommand(launch);
      this.#launchBlocks = launchCommands(launch).length;
      // A reattach first makes sure a server whose socket was deleted is reachable again, so the
      // launch does not start a second server and report a reboot (plan §6.10).
      if (this.#opts.previousIdentity !== null) await this.#recoverSocket(ctx.transport);
      const channel = await ctx.transport.exec(command);
      this.#channel = channel;
      if (this.#pausedBy.size > 0) channel.pause();
      this.#correlator = new CommandCorrelator((line) => this.#write(`${line}\n`));
      void this.#pumpStderr(channel);
      void this.#pumpStdout(channel);

      const created = await this.#launch.promise;
      this.#stats.created = created;
      await this.#detachStaleClients();
      const identity = await this.#readIdentity();
      const previous = this.#opts.previousIdentity;
      const rebooted =
        previous !== null &&
        (previous.sessionCreated !== identity.sessionCreated ||
          previous.panePid !== identity.panePid);
      // The runtime writes the "remote host restarted" banner itself when rebooted is true.
      this.#opts.onIdentity(identity, rebooted, created);
      if (created && typedStartup !== null) this.#typeStartup(typedStartup);
      await this.#command(refreshClientPauseAfter(this.#opts.pauseAfterSeconds ?? 5));
      await this.#command(refreshClientSize(dims.cols, dims.rows));
      await this.#queueResync('attach', null);
      if (this.#phase !== 'starting') throw new Error('tmux control client closed during start');
      this.#phase = 'running';
    } catch (err) {
      if (this.#phase === 'starting') this.#phase = 'closed';
      this.#endChannel();
      // A session that died during start is a shell exit, not a failed attempt: once the launch
      // has run, confirm with has-session before rejecting, so the runtime sees onShellExit first
      // (one outcome per attempt, ADR-0003).
      this.#exitConfirmation ??= this.#launched ? this.#confirmExit('start failed', true) : null;
      if (this.#exitConfirmation) await withTimeout(this.#exitConfirmation, REAP_TIMEOUT_MS);
      throw err;
    }
    const resize = this.#deferredResize;
    this.#deferredResize = null;
    if (resize) this.resize(resize);
    this.#flushInput();
  }

  input(data: Uint8Array): void {
    if ((this.#phase !== 'running' && this.#phase !== 'starting') || data.byteLength === 0) return;
    this.#input.push(data.slice());
    this.#inputBytes += data.byteLength;
    if (this.#phase !== 'running') return; // flushed once started
    if (this.#inputBytes >= MAX_INPUT_BYTES_PER_COMMAND) this.#flushInput();
    else this.#inputTimer ??= setTimeout(() => this.#flushInput(), INPUT_COALESCE_MS);
  }

  resize(dims: Dimensions): void {
    if (this.#phase === 'starting') {
      this.#deferredResize = { cols: dims.cols, rows: dims.rows };
      return;
    }
    if (this.#phase !== 'running' || !this.#correlator) return;
    this.#correlator.send(refreshClientSize(dims.cols, dims.rows)).catch(() => {});
  }

  pauseOutput(): void {
    this.#pauseReading('runtime', true);
  }

  resumeOutput(): void {
    this.#pauseReading('runtime', false);
  }

  #pauseReading(reason: 'runtime' | 'rebuild', paused: boolean): void {
    const before = this.#pausedBy.size;
    if (paused) this.#pausedBy.add(reason);
    else this.#pausedBy.delete(reason);
    if (before === 0 && this.#pausedBy.size > 0) {
      this.#readResume = deferred<void>();
      this.#channel?.pause();
    } else if (before > 0 && this.#pausedBy.size === 0) {
      this.#channel?.resume();
      this.#readResume?.resolve();
      this.#readResume = null;
    }
  }

  async detach(): Promise<void> {
    this.#flushInput();
    const phase = this.#phase;
    this.#phase = 'detaching';
    if ((phase === 'running' || phase === 'starting') && this.#channel && !this.#channelDone) {
      this.#exitWaiter = deferred<void>();
      this.#pauseReading('rebuild', false);
      this.resumeOutput();
      // An empty line detaches a control client; tmux answers with %exit.
      this.#write('\n');
      await withTimeout(this.#exitWaiter.promise, CLOSE_TIMEOUT_MS);
    }
    this.#endChannel();
    this.#phase = 'closed';
  }

  async terminate(): Promise<void> {
    this.#clearInput();
    const phase = this.#phase;
    this.#phase = 'terminating';
    if ((phase === 'running' || phase === 'starting') && this.#correlator && !this.#channelDone) {
      this.#exitWaiter = deferred<void>();
      this.#pauseReading('rebuild', false);
      this.resumeOutput();
      const reply = this.#correlator.send(killServer()).catch(() => null);
      await withTimeout(reply, CLOSE_TIMEOUT_MS);
      await withTimeout(this.#exitWaiter.promise, CLOSE_TIMEOUT_MS);
    }
    if (this.#ctx) {
      // A fresh exec kills the server when no control client was left to do it, and in any case
      // the processes of our socket that would keep it alive (see killServerCommand).
      const done = exitCodeOf(this.#ctx.transport, killServerCommand(this.#target()));
      await withTimeout(done, REAP_TIMEOUT_MS).catch(() => null);
    }
    this.#endChannel();
    this.#phase = 'closed';
  }

  // ── attach steps ──────────────────────────────────────────────────────────────────────────

  /**
   * Socket recovery (plan §6.10): when our server does not answer but a tmux process for our
   * socket still runs, its socket file was deleted; SIGUSR1 makes tmux recreate it. Without such
   * a process the launch creates a new session (remote reboot, or the session ended).
   */
  async #recoverSocket(transport: Transport): Promise<void> {
    const code = await exitCodeOf(transport, recoverSocketCommand(this.#target()));
    if (code === 2) this.#stats.socketRecoveries++;
  }

  async #detachStaleClients(): Promise<void> {
    const [own, clients] = await Promise.all([
      this.#command(displayFormat('#{client_name}')),
      this.#command(listClients()),
    ]);
    const ownName = text(own.lines);
    const stale = clients.lines
      .map((line) => parseListedClient(decoder.decode(line)))
      .filter((c): c is ListedClient => c?.controlMode === true && c.name !== ownName);
    // Results are irrelevant: a stale client may already be gone.
    await Promise.all(stale.map((c) => this.#correlator!.send(detachClient(c.name))));
    this.#stats.staleClientsDetached += stale.length;
  }

  async #readIdentity(): Promise<RemoteIdentity> {
    const reply = await this.#command(
      displayFormat('#{session_created} #{pane_pid} #{pane_id} #{window_id}'),
    );
    const match = /^(\d+) (\d+) %(\d+) @(\d+)$/.exec(text(reply.lines));
    if (!match) throw new TmuxDesyncError(`unexpected identity reply: ${text(reply.lines)}`);
    this.#paneId = Number(match[3]);
    this.#windowId = Number(match[4]);
    return { sessionCreated: Number(match[1]), panePid: Number(match[2]) };
  }

  #typeStartup(command: string): void {
    const bytes = encoder.encode(`${command}\r`);
    for (const line of encodeInput(this.#paneId!, bytes)) {
      this.#correlator!.send(line).catch(() => {});
    }
  }

  /** Sends a command that must succeed. */
  async #command(command: string): Promise<CommandResult> {
    const result = await this.#correlator!.send(command);
    if (!result.ok) {
      throw new TmuxDesyncError(`'${command.split(' ')[0]}' failed: ${text(result.lines)}`);
    }
    return result;
  }

  #target(): { tmuxPath: string; socket: string } {
    return { tmuxPath: this.#opts.probe.tmuxPath!, socket: this.#opts.socket };
  }

  // ── snapshot and rebuild ──────────────────────────────────────────────────────────────────

  /**
   * Queues a snapshot + rebuild after any running one. Requests arriving before the queued one
   * starts merge into it (a pending `continue` is kept).
   */
  #queueResync(reason: string, continuePane: number | null): Promise<void> {
    const queued = this.#resyncQueued;
    if (queued) {
      queued.continuePane ??= continuePane;
      return queued.run;
    }
    const entry = { reason, continuePane, run: Promise.resolve() };
    entry.run = this.#resyncChain.then(() => {
      this.#resyncQueued = null;
      return this.#resync(entry.reason, entry.continuePane);
    });
    this.#resyncQueued = entry;
    this.#resyncChain = entry.run.catch(() => {});
    return entry.run;
  }

  #requestResync(reason: string, continuePane: number | null): void {
    if (this.#phase !== 'running' && this.#phase !== 'starting') return;
    this.#queueResync(reason, continuePane).catch((err: Error) => this.#fail(err));
  }

  async #resync(reason: string, continuePane: number | null): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (this.#phase !== 'running' && this.#phase !== 'starting') return;
      const paneId = this.#paneId!;
      const gate = this.#gate;
      if (gate.phase === 'live') gate.arm();
      const prefix = continuePane !== null ? [refreshClientContinue(continuePane)] : [];
      continuePane = null; // applied by this attempt (or moot if the pane is gone)
      const sentAt = performance.now();
      const result: BatchResult = await this.#correlator!.sendBatch(
        [...prefix, ...snapshotCommands(paneId)],
        { onBegin: () => gate.begin(), onEnd: () => gate.end() },
      );
      const captureMs = performance.now() - sentAt;
      let capture: PaneCapture | null = null;
      let problem: string | null = null;
      if (!result.ok) problem = text(result.blocks.at(-1)?.lines ?? []) || 'command failed';
      else if (gate.violated) problem = 'pane output inside the snapshot reply';
      else {
        capture = parseCapture(result.blocks.slice(prefix.length));
        if (capture.state.paneId !== paneId) problem = `pane is %${capture.state.paneId}`;
      }
      if (problem !== null || capture === null) {
        gate.retake();
        this.#heldBytes = 0;
        this.#pauseReading('rebuild', false);
        if (attempt >= SNAPSHOT_ATTEMPTS) {
          throw new TmuxDesyncError(`snapshot (${reason}) failed: ${problem}`);
        }
        await this.#followActivePane();
        continue;
      }
      const snapshot = capture;
      this.#paneInMode = snapshot.state.inMode;
      this.#report({ cols: snapshot.state.width, rows: snapshot.state.height });
      const carry = gate.carry;
      let bytes = 0;
      const builtAt = performance.now();
      await this.#ctx!.replaceState(async (fresh) => {
        bytes = await rebuild(fresh, snapshot, carry);
      });
      this.#stats.rebuilds++;
      this.#stats.lastRebuild = {
        reason,
        captureMs,
        buildMs: performance.now() - builtAt,
        historyLines: snapshot.history.length,
        bytes,
      };
      const held = gate.release();
      this.#heldBytes = 0;
      if (this.#phase === 'running' || this.#phase === 'starting') this.#replay(held);
      this.#pauseReading('rebuild', false);
      return;
    }
  }

  #replay(events: readonly StreamEvent[]): void {
    for (const event of events) {
      if (event.kind === 'output') {
        this.#forward.push(event.data);
      } else {
        this.#flushForward();
        this.#report(event.dims);
      }
    }
    this.#flushForward();
  }

  /** Re-reads the session's active window and pane; true when they changed. */
  async #followActivePane(): Promise<boolean> {
    const reply = await this.#command(displayFormat('#{window_id} #{pane_id}'));
    const match = /^@(\d+) %(\d+)$/.exec(text(reply.lines));
    if (!match) throw new TmuxDesyncError(`unexpected active pane reply: ${text(reply.lines)}`);
    const windowId = Number(match[1]);
    const paneId = Number(match[2]);
    const changed = windowId !== this.#windowId || paneId !== this.#paneId;
    this.#windowId = windowId;
    this.#paneId = paneId;
    return changed;
  }

  #report(dims: Dimensions): void {
    const last = this.#reportedSize;
    if (last && last.cols === dims.cols && last.rows === dims.rows) return;
    this.#reportedSize = { cols: dims.cols, rows: dims.rows };
    this.#ctx!.resized({ cols: dims.cols, rows: dims.rows });
  }

  // ── control channel ───────────────────────────────────────────────────────────────────────

  async #pumpStdout(channel: ExecChannel): Promise<void> {
    const splitter = new LineSplitter();
    try {
      for await (const chunk of channel.stdout) {
        this.#stats.receivedBytes += chunk.byteLength;
        for (const line of splitter.push(chunk)) this.#onLine(line);
        this.#flushForward();
        if (this.#pausedBy.size > 0) await this.#readResume?.promise;
      }
      const rest = splitter.end();
      if (rest) this.#onLine(rest);
    } catch (err) {
      // A line longer than tmux can produce: the stream is not what we think it is.
      if (err instanceof RangeError) this.#fail(new TmuxDesyncError(err.message));
    } finally {
      this.#flushForward();
      this.#onEof();
    }
  }

  async #pumpStderr(channel: ExecChannel): Promise<void> {
    for await (const chunk of channel.stderr) {
      // Keep only the beginning: it explains a failed launch.
      if (this.#stderr.length < 4096) this.#stderr += decoder.decode(chunk);
    }
  }

  #write(line: string): void {
    this.#channel?.write(encoder.encode(line));
  }

  #endChannel(): void {
    this.#clearInput();
    // Let the channel drain to its close.
    this.#pauseReading('rebuild', false);
    this.#pauseReading('runtime', false);
    this.#channel?.end();
  }

  #onLine(line: Uint8Array): void {
    const event = this.#parser.push(line);
    if (!event || !this.#correlator) return;
    let consumed: boolean;
    try {
      consumed = this.#correlator.handle(event);
    } catch (err) {
      this.#fail(err as Error);
      return;
    }
    if (consumed) this.#onBlock(event);
    else this.#onNotification(event);
  }

  /** Launch blocks (flags 0): the last one carries the "created" marker of `new-session -P`. */
  #onBlock(event: ControlEvent): void {
    if (event.type !== 'blockEnd' && event.type !== 'blockError') return;
    if ((event.guard.flags & 1) !== 0 || this.#launchSeen >= this.#launchBlocks) return;
    this.#launchSeen++;
    if (event.type === 'blockError') {
      this.#launch?.reject(new Error(`tmux launch failed: ${text(event.lines)}`));
    } else if (this.#launchSeen === this.#launchBlocks) {
      this.#launched = true;
      this.#launch?.resolve(event.lines.some((l) => decoder.decode(l) === SESSION_CREATED_MARKER));
    }
  }

  #onNotification(event: ControlEvent): void {
    switch (event.type) {
      case 'output':
      case 'extendedOutput':
        if (event.type === 'extendedOutput' && event.ageMs > this.#stats.maxOutputAgeMs) {
          this.#stats.maxOutputAgeMs = event.ageMs;
        }
        if (this.#paneId !== null && event.paneId !== this.#paneId) return;
        switch (this.#gate.push({ kind: 'output', data: event.data })) {
          case 'forward':
            this.#forward.push(event.data);
            break;
          case 'hold':
            this.#heldBytes += event.data.byteLength;
            if (this.#heldBytes > HOLD_LIMIT_BYTES) this.#pauseReading('rebuild', true);
            break;
          default:
            break;
        }
        return;
      case 'layoutChange': {
        if (event.windowId !== this.#windowId || this.#paneId === null) return;
        const dims = paneSizeFromLayout(event.layout, this.#paneId);
        if (dims && this.#gate.push({ kind: 'resize', dims }) === 'forward') {
          this.#flushForward();
          this.#report(dims);
        }
        return;
      }
      case 'pause':
        if (event.paneId !== this.#paneId) return;
        this.#stats.pauses++;
        // tmux discarded the pane's output since the pause: continue + full resync.
        this.#requestResync('pause', event.paneId);
        return;
      case 'exit':
        this.#onExit(event.reason);
        return;
      case 'windowPaneChanged':
        if (event.windowId !== this.#windowId || event.paneId === this.#paneId) return;
        this.#paneId = event.paneId;
        this.#requestResync('active pane changed', null);
        return;
      case 'windowClose':
        if (event.windowId === this.#windowId) this.#requestFollow();
        return;
      case 'paneModeChanged':
        if (event.paneId === this.#paneId) this.#refreshPaneMode();
        return;
      case 'unknown':
        if (event.malformed && (event.name === 'output' || event.name === 'extended-output')) {
          this.#fail(new TmuxDesyncError(`malformed %${event.name}: ${event.text.slice(0, 80)}`));
        } else if (
          event.name === 'session-window-changed' ||
          event.name === 'unlinked-window-close'
        ) {
          this.#requestFollow();
        }
        return;
      default:
        // %continue (acknowledged by the continue reply), %session-changed, %window-add, …
        return;
    }
  }

  #requestFollow(): void {
    if (this.#phase !== 'running') return;
    this.#followActivePane().then(
      (changed) => {
        if (changed) this.#requestResync('active pane changed', null);
      },
      () => {},
    );
  }

  #refreshPaneMode(): void {
    const paneId = this.#paneId;
    if (paneId === null || !this.#correlator) return;
    this.#correlator.send(displayFormat('#{pane_in_mode}', paneId)).then(
      (reply) => {
        if (reply.ok && paneId === this.#paneId) this.#paneInMode = text(reply.lines) === '1';
      },
      () => {},
    );
  }

  #flushForward(): void {
    if (this.#forward.length === 0) return;
    const data = this.#forward.length === 1 ? this.#forward[0]! : concatBytes(this.#forward);
    this.#forward = [];
    this.#ctx?.output(data);
  }

  #flushInput(): void {
    if (this.#inputTimer) {
      clearTimeout(this.#inputTimer);
      this.#inputTimer = null;
    }
    const paneId = this.#paneId;
    if (this.#input.length === 0 || this.#phase !== 'running' || paneId === null) return;
    const bytes = concatBytes(this.#input, this.#inputBytes);
    this.#input = [];
    this.#inputBytes = 0;
    const commands = encodeInput(paneId, bytes);
    if (this.#paneInMode) {
      commands.unshift(sendKeysCancel(paneId));
      this.#paneInMode = false;
    }
    for (const command of commands) this.#correlator!.send(command).catch(() => {});
  }

  #clearInput(): void {
    if (this.#inputTimer) clearTimeout(this.#inputTimer);
    this.#inputTimer = null;
    this.#input = [];
    this.#inputBytes = 0;
  }

  // ── endings ───────────────────────────────────────────────────────────────────────────────

  /**
   * `%exit` also follows detach-client, "too far behind" and server death (plan §6.10), so it
   * is confirmed with has-session in a fresh exec: gone → shell exited; alive → reattach.
   */
  #onExit(reason: string | undefined): void {
    this.#channelDone = true;
    const err = new Error(`tmux control client exited${reason ? ` (${reason})` : ''}`);
    this.#correlator?.failAll(err);
    this.#launch?.reject(err);
    this.#exitWaiter?.resolve();
    const phase = this.#phase;
    if (phase !== 'running' && phase !== 'starting') return;
    this.#phase = 'closed';
    this.#endChannel();
    // During start, only once the launch ran (before it, start() simply rejects and is retried).
    if (phase === 'running' || this.#launched) {
      this.#exitConfirmation ??= this.#confirmExit(err.message, phase === 'starting');
    }
  }

  /**
   * has-session in a fresh exec (confirmEndedCommand): gone → onShellExit, once no tmux process
   * of our socket is left; alive (also after recreating a deleted socket) → onDesync.
   */
  async #confirmExit(reason: string, duringStart: boolean): Promise<void> {
    const ctx = this.#ctx!;
    let code: number | null;
    try {
      code = await exitCodeOf(ctx.transport, confirmEndedCommand(this.#target()));
    } catch {
      return; // the transport is gone: the runtime's transport-loss path takes over
    }
    if (code !== null && code !== 0) ctx.onShellExit({ code: null });
    // Session alive: reattach. During start, start() itself rejects instead.
    else if (!duringStart) ctx.onDesync(reason);
  }

  /**
   * Channel EOF. Without %exit while running (the control client was killed, tmux crashed), ask
   * has-session on a fresh exec: gone → onShellExit, alive → onDesync('control channel closed').
   * When the exec fails, the transport is down and the runtime's transport-loss path handles it.
   * During start(), start() rejects and runs the same confirmation itself.
   */
  #onEof(): void {
    this.#channelDone = true;
    const err = new Error(
      `tmux control channel closed${this.#stderr ? `: ${this.#stderr.trim().slice(0, 300)}` : ''}`,
    );
    const phase = this.#phase;
    if (phase === 'running' || phase === 'starting') this.#phase = 'closed';
    if (phase === 'running') {
      this.#exitConfirmation ??= this.#confirmExit('control channel closed', false);
    }
    this.#correlator?.failAll(err);
    this.#launch?.reject(err);
    this.#exitWaiter?.resolve();
    this.#clearInput();
  }

  /**
   * Protocol inconsistency: drop our control client only (never the tmux session) and let the
   * runtime reattach with a new transport and driver. During start, start() rejects instead.
   */
  #fail(err: Error): void {
    const phase = this.#phase;
    if (phase !== 'running' && phase !== 'starting') return;
    this.#phase = 'closed';
    const desync = err instanceof TmuxDesyncError ? err : new TmuxDesyncError(err.message);
    this.#correlator?.failAll(desync);
    this.#launch?.reject(desync);
    this.#endChannel();
    if (phase === 'running') this.#ctx?.onDesync(desync.message);
  }
}
