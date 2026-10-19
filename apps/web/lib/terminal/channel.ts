import {
  type BinaryFrame,
  type ClientMessage,
  encodeFrame,
  FrameFlag,
  FrameType,
  type ServerMessage,
  type TerminalHint,
} from '@termdock/protocol/client';
import { Utf8Aligner } from '@termdock/terminal-config';
import { gunzip } from './gzip.ts';
import { Store } from './store.ts';
import type { Dimensions, Disposable, TerminalLike } from './types.ts';

/** Client-side debounce of viewport reports; the server applies its own 100 ms policy. */
export const VIEWPORT_DEBOUNCE_MS = 50;
/** INPUT frames stay far below the server's 1 MiB maxPayload (large pastes are split). */
export const MAX_INPUT_CHUNK = 64 * 1024;
/** Protocol bounds for a reported viewport (`dimension` in packages/protocol). */
const MAX_DIMENSION = 1000;
/** Focus reports (DECSET 1004): focus in, focus out. */
const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';

/**
 * - `idle`: no session.
 * - `attaching`: attach requested (or waiting for the connection); frames are ignored until the
 *   server confirms with `session.attached`.
 * - `syncing`: attached; the snapshot has not been applied yet.
 * - `live`: the terminal mirrors the session.
 * - `failed`: the server refused the attach (see `error`); not retried on reconnect.
 */
export type ChannelPhase = 'idle' | 'attaching' | 'syncing' | 'live' | 'failed';

export interface ChannelError {
  code: string;
  message: string;
}

export interface ChannelState {
  readonly channel: number;
  readonly sessionId: string | null;
  readonly phase: ChannelPhase;
  /** Session size the terminal currently renders (applied snapshot / sequenced resize). */
  readonly size: Dimensions | null;
  readonly scrollbackLines: number | null;
  /**
   * Whether this pane is the session's active attachment (its viewport drives the session
   * size). Passive panes render the session size scaled or letterboxed (plan §5.5).
   */
  readonly active: boolean;
  readonly title: string | null;
  /** A tip the daemon shows while its condition holds (plan D-33). */
  readonly hint: TerminalHint | null;
  readonly error: ChannelError | null;
}

export interface TerminalChannelOptions {
  terminal: TerminalLike;
  onTitle?(title: string): void;
  onBell?(): void;
  onError?(error: ChannelError): void;
  viewportDebounceMs?: number;
}

/** What a channel needs from its connection (internal). */
export interface ChannelHost {
  /** The socket is open and authenticated (`hello.ok` received). */
  readonly ready: boolean;
  send(message: ClientMessage): boolean;
  sendBinary(frame: Uint8Array<ArrayBuffer>): boolean;
  release(channel: number): void;
}

type ChannelMessage = Extract<
  ServerMessage,
  {
    type:
      | 'session.attached'
      | 'terminal.resized'
      | 'terminal.title'
      | 'terminal.bell'
      | 'terminal.hint'
      | 'error';
  }
>;

type Op =
  | { kind: 'attached'; scrollbackLines: number }
  | { kind: 'snapshot'; seq: bigint; size: Dimensions; gzip: boolean; payload: Uint8Array }
  | { kind: 'output'; seq: bigint; payload: Uint8Array }
  | { kind: 'resized'; size: Dimensions; active: boolean };

const encoder = new TextEncoder();

function clampViewport({ cols, rows }: Dimensions): Dimensions {
  const clamp = (v: number): number =>
    Number.isFinite(v) ? Math.min(MAX_DIMENSION, Math.max(1, Math.floor(v))) : 1;
  return { cols: clamp(cols), rows: clamp(rows) };
}

function sameSize(a: Dimensions | null, b: Dimensions | null): boolean {
  return a !== null && b !== null && a.cols === b.cols && a.rows === b.rows;
}

/** onBinary strings carry one byte per UTF-16 code unit. */
function latin1Bytes(data: string): Uint8Array {
  return Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff);
}

/**
 * One attached pane: a terminal mirroring one session over one channel of the tab's connection.
 *
 * Fidelity rules (plan §5.4/§5.5, ADR-0001): every incoming state change is applied in arrival
 * order through xterm's write queue, so it lands at its exact byte position (xterm parses
 * asynchronously; a bare `resize()`/`reset()` would overtake queued output):
 * - SNAPSHOT: later frames are queued while the payload is decompressed; then, inside a write
 *   callback, `reset()` → `resize(cols, rows)`, followed by `write(aligner.push(payload))` with a
 *   fresh `Utf8Aligner`; queued OUTPUT with seq ≤ snapshotSeq is dropped, the rest applied.
 * - OUTPUT: `write(aligner.push(payload))` (one aligner per terminal, ADR-0001).
 * - `terminal.resized {seq}`: the socket is ordered, so it arrives after every OUTPUT ≤ seq; the
 *   resize goes through the write queue after them. A same-size message (an `activeAttachment`
 *   flip) never touches the terminal, exactly like the server's emulator.
 */
export class TerminalChannel {
  readonly id: number;
  readonly terminal: TerminalLike;
  readonly #host: ChannelHost;
  readonly #options: TerminalChannelOptions;
  readonly #store: Store<ChannelState>;
  readonly #subscriptions: Disposable[];
  #sessionId: string | null = null;
  #viewport: Dimensions = { cols: 80, rows: 24 };
  #sentViewport: Dimensions | null = null;
  #viewportTimer: ReturnType<typeof setTimeout> | null = null;
  #activatePending = false;
  // Incoming pipeline.
  #queue: Op[] = [];
  #busy = false;
  #token = 0;
  #aligner = new Utf8Aligner();
  #lastSeq = -1n;
  /** Terminal size once every queued resize has been applied. */
  #target: Dimensions | null = null;
  #scrollbackLines: number | null = null;
  #needsSnapshot = true;
  #idleWaiters: Array<() => void> = [];
  #disposed = false;

  constructor(id: number, host: ChannelHost, options: TerminalChannelOptions) {
    this.id = id;
    this.terminal = options.terminal;
    this.#host = host;
    this.#options = options;
    this.#store = new Store<ChannelState>({
      channel: id,
      sessionId: null,
      phase: 'idle',
      size: null,
      scrollbackLines: null,
      active: false,
      title: null,
      hint: null,
      error: null,
    });
    // Keystrokes, paste and mouse reports. INPUT also makes this the active attachment on the
    // server (plan §5.5), so no separate activate is needed.
    //
    // xterm emits focus reports on its own: on every `ESC[?1004h` in the output (a snapshot
    // replays it on each attach) it reports the current focus with no user action. Output must
    // never type into the session, so onData payloads that are exactly a focus report are
    // dropped, and real focus changes are reported below. No input produces exactly these
    // strings in xterm 6: a key arrives as one event with one sequence (Keyboard.ts has no
    // `CSI I` / `CSI O`; Alt+[ is `ESC [`, the `I` that follows is its own event), mouse, wheel
    // and alt-click reports are `CSI M…`, `CSI <…` and cursor keys, IME and soft-keyboard text
    // is typed text, and a paste arrives whole, either bracketed (`ESC[200~…`) or as plain text
    // without ESC (paste.ts).
    const textarea = this.terminal.textarea;
    const onFocus = (): void => this.#reportFocus(true);
    const onBlur = (): void => this.#reportFocus(false);
    textarea?.addEventListener('focus', onFocus);
    textarea?.addEventListener('blur', onBlur);
    this.#subscriptions = [
      this.terminal.onData((data) => {
        if (data !== FOCUS_IN && data !== FOCUS_OUT) this.input(data);
      }),
      this.terminal.onBinary((data) => this.input(latin1Bytes(data))),
      {
        dispose: () => {
          textarea?.removeEventListener('focus', onFocus);
          textarea?.removeEventListener('blur', onBlur);
        },
      },
    ];
  }

  readonly getSnapshot = (): ChannelState => this.#store.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.#store.subscribe(listener);

  /** Attaches a session to this pane (detaching the current one first). */
  attach(sessionId: string, viewport: Dimensions): void {
    if (this.#disposed) throw new Error('channel disposed');
    const { phase } = this.#store.getSnapshot();
    if (sessionId === this.#sessionId && phase !== 'idle' && phase !== 'failed') {
      this.setViewport(viewport);
      return;
    }
    if (this.#sessionId !== null) this.detach();
    this.#sessionId = sessionId;
    this.#viewport = clampViewport(viewport);
    this.#store.update({
      sessionId,
      phase: 'attaching',
      active: false,
      title: null,
      hint: null,
      error: null,
    });
    this.#sendAttach();
  }

  /** Detaches; the terminal keeps showing its last state. */
  detach(): void {
    if (this.#sessionId === null) return;
    if (this.#host.ready) this.#host.send({ type: 'session.detach', channel: this.id });
    this.#sessionId = null;
    this.#activatePending = false;
    this.#clearViewportTimer();
    this.#resetPipeline();
    this.#store.update({ sessionId: null, phase: 'idle', active: false, hint: null, error: null });
  }

  /** Focus or click: this pane becomes the active attachment (its viewport sizes the session). */
  activate(): void {
    if (this.#isAttached() && this.#host.ready) {
      this.#host.send({ type: 'terminal.activate', channel: this.id });
    } else if (this.#sessionId !== null) {
      this.#activatePending = true;
    }
  }

  /** Reports the fitted viewport (debounced). The terminal itself is only resized by the server. */
  setViewport(viewport: Dimensions): void {
    this.#viewport = clampViewport(viewport);
    this.#clearViewportTimer();
    this.#viewportTimer = setTimeout(() => {
      this.#viewportTimer = null;
      this.#flushViewport();
    }, this.#options.viewportDebounceMs ?? VIEWPORT_DEBOUNCE_MS);
  }

  /** Asks the server for a fresh snapshot. */
  resync(): void {
    if (this.#isAttached() && this.#host.ready) {
      this.#host.send({ type: 'terminal.resync', channel: this.id });
    }
  }

  /** User input (UTF-8 for strings). Dropped while not attached; never buffered across drops. */
  input(data: string | Uint8Array): void {
    if (!this.#isAttached() || !this.#host.ready) return;
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    for (let at = 0; at < bytes.length; at += MAX_INPUT_CHUNK) {
      const payload = bytes.subarray(at, at + MAX_INPUT_CHUNK);
      const frame = encodeFrame({
        type: FrameType.Input,
        flags: 0,
        channel: this.id,
        seq: 0n,
        payload,
      }) as Uint8Array<ArrayBuffer>;
      this.#host.sendBinary(frame);
    }
  }

  /** Resolves once every frame received so far is applied and parsed by the terminal. */
  async settled(): Promise<void> {
    while (this.#busy || this.#queue.length > 0) {
      await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
    }
    await new Promise<void>((resolve) => this.#termWrite('', resolve));
  }

  /** Detaches and frees the channel number. The terminal is left to its owner. */
  dispose(): void {
    if (this.#disposed) return;
    this.detach();
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#clearViewportTimer();
    this.#disposed = true;
    this.#host.release(this.id);
  }

  // ── connection events (called by TermdockConnection) ───────────────────────

  /** @internal The connection is (re)authenticated: (re)attach; the server sends a fresh snapshot. */
  handleConnected(): void {
    const { phase } = this.#store.getSnapshot();
    if (this.#sessionId === null || phase === 'failed') return;
    this.#store.update({ phase: 'attaching' });
    this.#sendAttach();
  }

  /** @internal The socket closed; frames in flight are lost, a re-attach follows on reconnect. */
  handleDisconnected(): void {
    this.#clearViewportTimer();
    this.#resetPipeline();
    const { phase } = this.#store.getSnapshot();
    if (this.#sessionId !== null && phase !== 'failed') {
      this.#store.update({ phase: 'attaching', active: false });
    }
  }

  /** @internal */
  handleMessage(message: ChannelMessage): void {
    switch (message.type) {
      case 'session.attached': {
        const { phase } = this.#store.getSnapshot();
        // A stale confirmation of an earlier attach on this channel, or nothing requested.
        if (message.sessionId !== this.#sessionId || phase === 'idle' || phase === 'failed') return;
        // The daemon sends the current hint, if any, right after this message.
        this.#store.update({ phase: 'syncing', error: null, hint: null });
        this.#enqueue({ kind: 'attached', scrollbackLines: message.scrollbackLines });
        this.#flushViewport();
        if (this.#activatePending) {
          this.#activatePending = false;
          this.#host.send({ type: 'terminal.activate', channel: this.id });
        }
        return;
      }
      case 'terminal.resized':
        if (!this.#isAttached()) return;
        this.#enqueue({
          kind: 'resized',
          size: { cols: message.cols, rows: message.rows },
          active: message.activeAttachment,
        });
        return;
      case 'terminal.title':
        if (!this.#isAttached()) return;
        this.#store.update({ title: message.title });
        this.#options.onTitle?.(message.title);
        return;
      case 'terminal.bell':
        if (this.#isAttached()) this.#options.onBell?.();
        return;
      case 'terminal.hint':
        if (this.#isAttached()) this.#store.update({ hint: message.hint });
        return;
      case 'error': {
        const error = { code: message.code, message: message.message };
        const { phase } = this.#store.getSnapshot();
        this.#store.update({ error, ...(phase === 'attaching' ? { phase: 'failed' } : {}) });
        this.#options.onError?.(error);
        return;
      }
    }
  }

  /** @internal */
  handleFrame(frame: BinaryFrame): void {
    if (!this.#isAttached()) return;
    if (frame.type === FrameType.Snapshot && frame.size) {
      this.#enqueue({
        kind: 'snapshot',
        seq: frame.seq,
        size: frame.size,
        gzip: (frame.flags & FrameFlag.Gzip) !== 0,
        payload: frame.payload,
      });
    } else if (frame.type === FrameType.Output) {
      this.#enqueue({ kind: 'output', seq: frame.seq, payload: frame.payload });
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  #isAttached(): boolean {
    const { phase } = this.#store.getSnapshot();
    return phase === 'syncing' || phase === 'live';
  }

  /**
   * Focus reports for a real focus change of the terminal, while the program asked for them.
   * Focus-in makes this pane active, as a focus does anyway; focus-out is only sent by the active
   * attachment, or leaving a pane would make it the one that sizes the session.
   */
  #reportFocus(focused: boolean): void {
    if (!this.terminal.modes.sendFocusMode) return;
    if (focused) this.input(FOCUS_IN);
    else if (this.#store.getSnapshot().active) this.input(FOCUS_OUT);
  }

  #sendAttach(): void {
    if (!this.#host.ready || this.#sessionId === null) return;
    this.#resetPipeline();
    this.#sentViewport = this.#viewport;
    this.#host.send({
      type: 'session.attach',
      channel: this.id,
      sessionId: this.#sessionId,
      viewport: this.#viewport,
    });
  }

  #flushViewport(): void {
    if (!this.#isAttached() || !this.#host.ready || sameSize(this.#viewport, this.#sentViewport)) {
      return;
    }
    this.#sentViewport = this.#viewport;
    this.#host.send({ type: 'terminal.viewport', channel: this.id, ...this.#viewport });
  }

  #clearViewportTimer(): void {
    if (this.#viewportTimer) clearTimeout(this.#viewportTimer);
    this.#viewportTimer = null;
  }

  /** Drops queued frames and invalidates a snapshot being decompressed. */
  #resetPipeline(): void {
    this.#token++;
    this.#queue = [];
    this.#busy = false;
    this.#needsSnapshot = true;
    this.#notifyIdle();
  }

  #enqueue(op: Op): void {
    this.#queue.push(op);
    this.#drain();
  }

  #drain(): void {
    while (!this.#busy && this.#queue.length > 0) {
      const op = this.#queue.shift()!;
      if (op.kind !== 'snapshot') {
        this.#apply(op);
        continue;
      }
      this.#busy = true;
      const token = this.#token;
      void this.#applySnapshot(op, token).finally(() => {
        if (token !== this.#token) return;
        this.#busy = false;
        this.#drain();
      });
    }
    if (!this.#busy && this.#queue.length === 0) this.#notifyIdle();
  }

  #notifyIdle(): void {
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #apply(op: Exclude<Op, { kind: 'snapshot' }>): void {
    switch (op.kind) {
      case 'attached':
        this.#scrollbackLines = op.scrollbackLines;
        this.#store.update({ scrollbackLines: op.scrollbackLines });
        return;
      case 'output':
        // Covered by the snapshot (seq ≤ snapshotSeq) or already applied.
        if (this.#needsSnapshot || op.seq <= this.#lastSeq) return;
        this.#lastSeq = op.seq;
        this.#write(op.payload);
        return;
      case 'resized': {
        if (this.#store.getSnapshot().active !== op.active) {
          this.#store.update({ active: op.active });
        }
        if (this.#needsSnapshot || sameSize(op.size, this.#target)) return;
        const { cols, rows } = op.size;
        this.#target = { cols, rows };
        this.#termWrite('', () => {
          this.terminal.resize(cols, rows);
          this.#store.update({ size: { cols, rows } });
        });
        return;
      }
    }
  }

  async #applySnapshot(op: Extract<Op, { kind: 'snapshot' }>, token: number): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = op.gzip ? await gunzip(op.payload) : op.payload;
    } catch {
      // Undecodable snapshot: keep dropping frames until a fresh one arrives (plan §5.4).
      if (token === this.#token) this.resync();
      return;
    }
    if (token !== this.#token) return;
    const { cols, rows } = op.size;
    const scrollback = this.#scrollbackLines;
    const term = this.terminal;
    // The old carry belongs to the replaced stream; the snapshot may itself end mid-character.
    this.#aligner = new Utf8Aligner();
    this.#target = { cols, rows };
    this.#lastSeq = op.seq;
    this.#needsSnapshot = false;
    this.#termWrite('', () => {
      if (scrollback !== null && term.options.scrollback !== scrollback) {
        term.options.scrollback = scrollback;
      }
      term.reset();
      term.resize(cols, rows);
      this.#store.update({ size: { cols, rows } });
    });
    this.#write(bytes);
    this.#store.update({ phase: 'live' });
  }

  #write(data: Uint8Array): void {
    const bytes = this.#aligner.push(data);
    if (bytes.length > 0) this.#termWrite(bytes);
  }

  #termWrite(data: string | Uint8Array, callback?: () => void): void {
    // A callback must never throw inside xterm's write loop.
    const guarded = callback
      ? () => {
          try {
            callback();
          } catch {
            this.#recover();
          }
        }
      : undefined;
    try {
      this.terminal.write(data, guarded);
    } catch {
      // xterm discards writes beyond its 50 MB buffer: start over from a fresh snapshot.
      this.#recover();
    }
  }

  /** The local state can no longer be trusted (decode error, discarded write): resync. */
  #recover(): void {
    if (this.#needsSnapshot) return;
    this.#needsSnapshot = true;
    this.#store.update({ phase: 'syncing' });
    this.resync();
  }
}
