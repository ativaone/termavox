import {
  installQuerySilencer,
  ModeTracker,
  sharedTerminalOptions,
  UNICODE_VERSION,
  Utf8Aligner,
} from '@termdock/terminal-config';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import headless, { type Terminal } from '@xterm/headless';
import type { Dimensions, Emulator } from '../core/types.ts';
import { clippedTerminalView } from './serialize-view.ts';

/** xterm clamps sizes to these (CoreTerminal MINIMUM_COLS / MINIMUM_ROWS). */
const MIN_COLS = 2;
const MIN_ROWS = 1;
/** What SerializeAddon emits before the alternate buffer contents. */
const ALT_SCREEN_ENTRY = '\x1b[?1049h\x1b[H';
const SGR_RESET = '\x1b[0m';
const ESC = 0x1b;
/**
 * C1 controls that open a sequence from any parser state in xterm 6 (CSI, OSC, DCS, SOS, PM,
 * APC). They arrive UTF-8 encoded as `C2 xx`; the aligner never splits such a pair.
 */
const C1_INTRODUCERS = new Set([0x9b, 0x9d, 0x90, 0x98, 0x9e, 0x9f]);
/** An incomplete string sequence (OSC/DCS) longer than this is replayed truncated. */
const MAX_TAIL = 64 * 1024;
const EMPTY = new Uint8Array(0);

/** The xterm 6.0.0 internals used for snapshots (the version is pinned by a T0 test). */
interface XtermInternals {
  readonly _inputHandler: {
    readonly _parser: {
      readonly currentState: number;
      readonly initialState: number;
      /** Non-zero iff the last completed parser action was a print. */
      readonly precedingJoinState: number;
    };
    readonly _curAttrData: { readonly fg: number; readonly bg: number };
  };
  readonly buffers: { readonly active: { readonly scrollTop: number } };
}

/** Cells returned by `IBufferLine.getCell` are xterm `CellData` objects. */
interface CellInternals {
  readonly fg: number;
  readonly bg: number;
}

export interface HeadlessEmulatorOptions extends Dimensions {
  scrollback: number;
  /**
   * Whether this emulator answers terminal queries (DA, DSR/CPR, DECRQM, …). True for `none` /
   * `tmux-normal`; false for `tmux-control`, where tmux answers (plan §5.3).
   */
  answerQueries: boolean;
}

/** Index where the last escape sequence in `chunk` starts, or -1. */
function lastIntroducer(chunk: Uint8Array): number {
  for (let i = chunk.length - 1; i >= 0; i--) {
    const b = chunk[i]!;
    if (b === ESC) return i;
    if (C1_INTRODUCERS.has(b) && i > 0 && chunk[i - 1] === 0xc2) return i - 1;
  }
  return -1;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Authoritative terminal state of one session: an @xterm/headless terminal configured exactly
 * like the browser's, plus SerializeAddon and the mode tracker for snapshots.
 */
export class HeadlessEmulator implements Emulator {
  /** The underlying terminal, exposed for tests and diagnostics only. */
  readonly terminal: Terminal;
  readonly modeTracker: ModeTracker;
  private readonly serializer = new SerializeAddon();
  private readonly encoder = new TextEncoder();
  private readonly utf8 = new Utf8Aligner();
  private readonly core: XtermInternals;
  /** Bytes of the escape sequence the parser is in the middle of (empty in ground state). */
  private sequenceTail: Uint8Array = EMPTY;
  /** Size after every queued resize has been applied. */
  private targetCols: number;
  private targetRows: number;

  constructor(opts: HeadlessEmulatorOptions) {
    // The package is a CJS bundle; Node only exposes its default export to ESM.
    this.terminal = new headless.Terminal({
      ...sharedTerminalOptions,
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback,
    });
    this.targetCols = this.terminal.cols;
    this.targetRows = this.terminal.rows;
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = UNICODE_VERSION;
    // Activated on a clipped view instead of loadAddon() (see clippedTerminalView).
    this.serializer.activate(clippedTerminalView(this.terminal));
    this.modeTracker = new ModeTracker(this.terminal);
    if (!opts.answerQueries) installQuerySilencer(this.terminal);
    this.core = (this.terminal as unknown as { _core: XtermInternals })._core;
  }

  get cols(): number {
    return this.targetCols;
  }

  get rows(): number {
    return this.targetRows;
  }

  write(data: Uint8Array): void {
    // Only complete UTF-8 sequences reach xterm (decoder bug, see Utf8Aligner); xterm itself
    // still decodes statefully, the aligner just moves the chunk boundary.
    const bytes = this.utf8.push(data);
    if (bytes.length) this.terminal.write(bytes, () => this.trackSequenceTail(bytes));
  }

  resize({ cols, rows }: Dimensions): void {
    this.targetCols = Math.max(cols, MIN_COLS);
    this.targetRows = Math.max(rows, MIN_ROWS);
    // Write callbacks run synchronously between chunks, so the resize lands exactly between the
    // bytes written before and after this call.
    this.terminal.write('', () => this.terminal.resize(cols, rows));
  }

  /** An incomplete trailing UTF-8 character stays pending, as it would in xterm's decoder. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.terminal.write('', resolve));
  }

  snapshot(): Promise<Uint8Array> {
    // The aligner works at submission time: its carry belongs to the bytes written before now.
    const partialChar = this.utf8.pending;
    return new Promise((resolve, reject) => {
      this.terminal.write('', () => {
        // Never let an exception escape into xterm's write loop.
        try {
          const state = this.encoder.encode(this.serializeState());
          resolve(concat(state, this.sequenceTail, partialChar));
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  onReply(cb: (data: Uint8Array) => void): void {
    this.terminal.onData((data) => cb(this.encoder.encode(data)));
    // onBinary carries raw bytes as a latin1 string (legacy X10 mouse reports).
    this.terminal.onBinary((data) => cb(Buffer.from(data, 'latin1')));
  }

  onTitle(cb: (title: string) => void): void {
    this.terminal.onTitleChange(cb);
  }

  onBell(cb: () => void): void {
    this.terminal.onBell(cb);
  }

  dispose(): void {
    this.modeTracker.dispose();
    this.terminal.dispose();
  }

  /**
   * Runs after each chunk is parsed. A serialized screen cannot express "in the middle of an
   * escape sequence", so the bytes of an unfinished sequence are kept and replayed at the end of
   * the snapshot. A sequence starts at ESC or at a UTF-8-encoded C1 introducer.
   */
  private trackSequenceTail(chunk: Uint8Array): void {
    const parser = this.core._inputHandler._parser;
    if (parser.currentState === parser.initialState) {
      this.sequenceTail = EMPTY;
      return;
    }
    const at = lastIntroducer(chunk);
    if (at >= 0) {
      this.sequenceTail = chunk.slice(at, at + MAX_TAIL);
    } else if (this.sequenceTail.length && this.sequenceTail.length < MAX_TAIL) {
      // Still inside a sequence opened in an earlier chunk (e.g. a long OSC or DCS string).
      const room = MAX_TAIL - this.sequenceTail.length;
      this.sequenceTail = concat(this.sequenceTail, chunk.subarray(0, room));
    }
  }

  /** SerializeAddon output plus the mode epilogue; must run inside a write callback. */
  private serializeState(): string {
    let data = this.serializer.serialize();
    const at = data.lastIndexOf(ALT_SCREEN_ENTRY);
    if (this.terminal.buffer.active.type === 'alternate' && at >= 0) {
      // SerializeAddon leaves the normal buffer's current SGR applied but serializes the
      // alternate buffer as if starting from default attributes; reset in between. The normal
      // buffer's own tab stops and margins can only be restored before the switch. Cell contents
      // never contain ESC, so the last occurrence is SerializeAddon's own switch.
      const normal = this.modeTracker.normalBufferEpilogue();
      data = data.slice(0, at) + SGR_RESET + normal + data.slice(at);
    }
    return data + this.modeTracker.epilogue() + this.reprintLastCell();
  }

  /**
   * xterm joins a combining mark, ZWJ or VS16 to the previously printed character even across
   * chunks, but every escape sequence resets that join state. When the last parser action was a
   * print, the snapshot therefore ends by printing that character again, in place and with the
   * same attributes. This also restores the pending-wrap position (x == cols), which no cursor
   * sequence can express.
   */
  private reprintLastCell(): string {
    const { _parser: parser, _curAttrData: attr } = this.core._inputHandler;
    const buffer = this.terminal.buffer.active;
    const { cursorX: x, cursorY: y } = buffer;
    if (parser.precedingJoinState === 0 || x === 0 || this.terminal.modes.insertMode) return '';
    const line = buffer.getLine(buffer.baseY + y);
    let cellX = x - 1;
    let cell = line?.getCell(cellX);
    if (cell && cell.getWidth() === 0 && cellX > 0) cell = line?.getCell(--cellX);
    const raw = cell as unknown as CellInternals | undefined;
    // A queued resize since the print may have moved the cursor: only reprint the cell if it
    // could be the one just printed (content, current attributes).
    if (!cell?.getChars() || raw?.fg !== attr.fg || raw?.bg !== attr.bg) return '';
    const row = this.terminal.modes.originMode ? y - this.core.buffers.active.scrollTop : y;
    return `\x1b[${row + 1};${cellX + 1}H${cell.getChars()}`;
  }
}
