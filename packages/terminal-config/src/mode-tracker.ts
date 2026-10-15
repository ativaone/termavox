/**
 * Server-side mode tracker (plan §5.4, ADR-0001). Observes the parser through handlers that
 * always return `false`, so xterm's default handling still runs, and records the terminal state
 * that SerializeAddon 0.14 does not serialize. `epilogue()` turns that state into escape
 * sequences written after the serialized snapshot.
 *
 * The bookkeeping mirrors xterm 6.0.0 (`InputHandler`, `Buffer`, `BufferSet`) exactly, quirks
 * included, because the goal is "same bytes → same state" between the server and the browser,
 * not VT conformance. The golden tests compare the result against xterm's internal state.
 */
import type { ParserHost } from './index.ts';

interface Disposable {
  dispose(): void;
}

type BufferType = 'normal' | 'alternate';

/** Structural subset of the xterm API used by the tracker (@xterm/xterm and @xterm/headless). */
export interface TrackedTerminal extends ParserHost {
  readonly cols: number;
  readonly rows: number;
  readonly modes: { readonly originMode: boolean; readonly synchronizedOutputMode: boolean };
  readonly options: { readonly tabStopWidth?: number | undefined };
  readonly buffer: {
    readonly active: {
      readonly type: BufferType;
      readonly cursorX: number;
      readonly cursorY: number;
    };
    readonly normal: { readonly cursorX: number; readonly cursorY: number };
    onBufferChange(cb: (buffer: { readonly type: BufferType }) => void): Disposable;
  };
  onResize(cb: (size: { cols: number; rows: number }) => void): Disposable;
  onTitleChange(cb: (title: string) => void): Disposable;
}

export type MouseEncoding = 'default' | 'sgr' | 'sgr-pixels';
export type CursorShape = 'block' | 'underline' | 'bar';

export interface BufferModeState {
  /** Tab stops inside the current width (stops beyond it are kept but cannot be restored). */
  tabStops: number[];
  /** Scroll region (DECSTBM), 0-based inclusive rows. */
  scrollTop: number;
  scrollBottom: number;
}

/** Plain-data view of the tracked state, for diagnostics and tests. */
export interface ModeState {
  /** DECSET 1006 / 1016. 1005 and 1015 are ignored by xterm 6 and need no tracking. */
  mouseEncoding: MouseEncoding;
  /** DECSCUSR; `undefined` = the terminal's configured cursor (never set or reset). */
  cursorShape: CursorShape | undefined;
  cursorShapeBlink: boolean | undefined;
  /**
   * The next fields are not cleared by `Terminal.reset()`, so they are `undefined` until the
   * stream first touches them and are restored explicitly from then on, even when they hold the
   * default value (a reused client terminal may hold a stale value).
   */
  /** DECTCEM (DECSET 25). Note: xterm 6 does not show the cursor again on RIS. */
  cursorVisible: boolean | undefined;
  /** DECSET 12; xterm applies it to the `cursorBlink` option. */
  cursorBlink: boolean | undefined;
  /** LNM (SM 20); xterm applies it to the `convertEol` option. */
  newlineMode: boolean | undefined;
  /** Last title from OSC 0 / OSC 2. */
  title: string | undefined;
  /** G0–G3 designations as the ESC final byte ('B' = US ASCII, the default). */
  charsets: string[];
  normal: BufferModeState;
  alternate: BufferModeState;
}

interface BufferTrack {
  tabs: Set<number>;
  scrollTop: number;
  scrollBottom: number;
}

const ESC = '\x1b';
const CSI = '\x1b[';
const DEFAULT_CHARSET = 'B';
/** Charset finals xterm 6 accepts (`CHARSETS` in common/data/Charsets.ts). */
const CHARSET_FINALS = '0AB4C5RQKYE6ZH7=';
/** Designator intermediates and their G level (`GLEVEL`; '/' is ignored by xterm). */
const CHARSET_DESIGNATORS: Record<string, number> = {
  '(': 0,
  ')': 1,
  '*': 2,
  '+': 3,
  '-': 1,
  '.': 2,
};
const G_DESIGNATOR = ['(', ')', '*', '+'];
const SHAPE_PS: Record<CursorShape, number> = { block: 2, underline: 4, bar: 6 };

/** xterm passes sub-parameters as nested arrays; top-level parameters are what handlers read. */
function topLevel(params: (number | number[])[]): number[] {
  return params.filter((p): p is number => typeof p === 'number');
}

export class ModeTracker {
  private readonly term: TrackedTerminal;
  private readonly disposables: Disposable[] = [];

  private mouseEncoding: MouseEncoding = 'default';
  private cursorShape: CursorShape | undefined;
  private cursorShapeBlink: boolean | undefined;
  private cursorVisible: boolean | undefined;
  private cursorBlink: boolean | undefined;
  private newlineMode: boolean | undefined;
  private title: string | undefined;
  private charsets: string[] = [];
  private readonly buffers: Record<BufferType, BufferTrack>;

  constructor(term: TrackedTerminal) {
    this.term = term;
    this.buffers = { normal: this.freshBuffer(), alternate: this.freshBuffer() };
    this.resetCharsets();
    const p = term.parser;
    const observe =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A): boolean => {
        fn(...args);
        return false;
      };
    this.disposables.push(
      p.registerCsiHandler({ prefix: '?', final: 'h' }, observe(this.decset(true))),
      p.registerCsiHandler({ prefix: '?', final: 'l' }, observe(this.decset(false))),
      p.registerCsiHandler({ final: 'h' }, observe(this.ansiMode(true))),
      p.registerCsiHandler({ final: 'l' }, observe(this.ansiMode(false))),
      p.registerCsiHandler({ intermediates: ' ', final: 'q' }, observe(this.decscusr)),
      p.registerCsiHandler({ final: 'r' }, observe(this.decstbm)),
      p.registerCsiHandler({ final: 'g' }, observe(this.tbc)),
      p.registerCsiHandler({ intermediates: '!', final: 'p' }, observe(this.decstr)),
      p.registerEscHandler({ final: 'H' }, observe(this.hts)),
      p.registerEscHandler({ final: 'c' }, observe(this.ris)),
      p.registerEscHandler({ intermediates: '%', final: '@' }, observe(this.defaultCharset)),
      p.registerEscHandler({ intermediates: '%', final: 'G' }, observe(this.defaultCharset)),
      term.onTitleChange((title) => {
        this.title = title;
      }),
      term.onResize(({ cols, rows }) => this.resized(cols, rows)),
      term.buffer.onBufferChange((buffer) => {
        // Leaving the alternate screen clears it (BufferSet.activateNormalBuffer → Buffer.clear).
        if (buffer.type === 'normal') this.buffers.alternate = this.freshBuffer();
      }),
    );
    for (const [intermediates, level] of Object.entries(CHARSET_DESIGNATORS)) {
      for (const final of CHARSET_FINALS) {
        this.disposables.push(
          p.registerEscHandler(
            { intermediates, final },
            observe(() => {
              this.charsets[level] = final;
            }),
          ),
        );
      }
    }
  }

  state(): ModeState {
    const view = (b: BufferTrack): BufferModeState => ({
      tabStops: this.visibleTabs(b),
      scrollTop: b.scrollTop,
      scrollBottom: b.scrollBottom,
    });
    return {
      mouseEncoding: this.mouseEncoding,
      cursorShape: this.cursorShape,
      cursorShapeBlink: this.cursorShapeBlink,
      cursorVisible: this.cursorVisible,
      cursorBlink: this.cursorBlink,
      newlineMode: this.newlineMode,
      title: this.title,
      charsets: [...this.charsets],
      normal: view(this.buffers.normal),
      alternate: view(this.buffers.alternate),
    };
  }

  /**
   * Escape sequences that restore the tracked state when written right after
   * `SerializeAddon.serialize()` output. Emits nothing for state left at its default, and ends
   * with an absolute CUP to the real cursor position (see `bufferEpilogue`).
   */
  epilogue(): string {
    let out = '';
    if (this.mouseEncoding === 'sgr') out += `${CSI}?1006h`;
    else if (this.mouseEncoding === 'sgr-pixels') out += `${CSI}?1016h`;
    if (this.cursorShape !== undefined) {
      out += `${CSI}${SHAPE_PS[this.cursorShape] - (this.cursorShapeBlink ? 1 : 0)} q`;
    } else if (this.cursorShapeBlink !== undefined) {
      // Only reachable through a non-standard DECSCUSR Ps; xterm then changes just the blink.
      out += `${CSI}${this.cursorShapeBlink ? 7 : 8} q`;
    }
    if (this.cursorVisible !== undefined) out += `${CSI}?25${this.cursorVisible ? 'h' : 'l'}`;
    if (this.cursorBlink !== undefined) out += `${CSI}?12${this.cursorBlink ? 'h' : 'l'}`;
    if (this.newlineMode !== undefined) out += `${CSI}20${this.newlineMode ? 'h' : 'l'}`;
    // SerializeAddon skips DECSET 2026 as "temporary"; a snapshot taken mid-frame must keep it.
    if (this.term.modes.synchronizedOutputMode) out += `${CSI}?2026h`;
    if (this.title !== undefined) out += `${ESC}]2;${this.title}\x07`;
    const active = this.term.buffer.active;
    out += this.bufferEpilogue(
      this.buffers[active.type],
      active.cursorX,
      active.cursorY,
      this.term.modes.originMode,
    );
    this.charsets.forEach((final, g) => {
      if (final !== DEFAULT_CHARSET) out += `${ESC}${G_DESIGNATOR[g]}${final}`;
    });
    return out;
  }

  /**
   * While the alternate screen is active, the normal buffer's own tab stops, scroll region and
   * cursor can only be restored before the serialized `CSI ? 1049 h` (which saves that cursor
   * for the return to the normal screen); this returns those sequences, or '' when the normal
   * buffer is active. SerializeAddon has not emitted DECOM yet at that point.
   */
  normalBufferEpilogue(): string {
    if (this.term.buffer.active.type !== 'alternate') return '';
    const normal = this.term.buffer.normal;
    return this.bufferEpilogue(this.buffers.normal, normal.cursorX, normal.cursorY, false);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private bufferEpilogue(b: BufferTrack, x: number, y: number, originMode: boolean): string {
    const { cols, rows } = this.term;
    let out = '';
    const tabs = this.visibleTabs(b);
    const defaults = this.defaultTabs(cols);
    if (tabs.length !== defaults.size || tabs.some((t) => !defaults.has(t))) {
      out += `${CSI}3g`;
      for (const t of tabs) out += `${CSI}${t + 1}G${ESC}H`;
    }
    if (b.scrollTop !== 0 || b.scrollBottom !== rows - 1) {
      out += `${CSI}${b.scrollTop + 1};${b.scrollBottom + 1}r`;
    }
    // Always finish with an absolute CUP: besides undoing the moves above, it corrects
    // SerializeAddon's relative cursor restore, which is off by one when the last content row
    // ends in the last column (xterm clamps x before CUB) and is reset by its trailing DECOM.
    // The pending-wrap position (x == cols) has no CUP form; SerializeAddon's own restore is
    // kept for it unless the cursor had to move anyway.
    if (x < cols || out || originMode) {
      // With DECOM set, CUP rows are relative to the top margin (xterm `_setCursor`).
      const row = originMode ? Math.max(y - b.scrollTop, 0) : y;
      out += `${CSI}${row + 1};${Math.min(x, cols - 1) + 1}H`;
    }
    return out;
  }

  private visibleTabs(b: BufferTrack): number[] {
    const cols = this.term.cols;
    return [...b.tabs].filter((t) => t < cols).sort((a, c) => a - c);
  }

  private get tabWidth(): number {
    return this.term.options.tabStopWidth ?? 8;
  }

  private defaultTabs(cols: number): Set<number> {
    const tabs = new Set<number>();
    for (let i = 0; i < cols; i += this.tabWidth) tabs.add(i);
    return tabs;
  }

  private freshBuffer(): BufferTrack {
    return {
      tabs: this.defaultTabs(this.term.cols),
      scrollTop: 0,
      scrollBottom: this.term.rows - 1,
    };
  }

  private get activeBuffer(): BufferTrack {
    return this.buffers[this.term.buffer.active.type];
  }

  private resetCharsets(): void {
    this.charsets = [DEFAULT_CHARSET, DEFAULT_CHARSET, DEFAULT_CHARSET, DEFAULT_CHARSET];
  }

  /** BufferSet.resize: both buffers reset their margins and extend their tab stops. */
  private resized(cols: number, rows: number): void {
    for (const b of Object.values(this.buffers)) {
      b.scrollTop = 0;
      b.scrollBottom = rows - 1;
      // Buffer.setupTabStops(cols): continue from the last stop below the new width.
      let i = cols;
      if (!b.tabs.has(i)) {
        let x = cols;
        do x--;
        while (!b.tabs.has(x) && x > 0);
        i = x >= cols ? cols - 1 : Math.max(x, 0);
      }
      for (; i < cols; i += this.tabWidth) b.tabs.add(i);
    }
  }

  private decset =
    (set: boolean) =>
    (params: (number | number[])[]): void => {
      for (const p of topLevel(params)) {
        switch (p) {
          case 2:
            // xterm resets all designations on DECSET 2 (DECANM) and ignores DECRST 2.
            if (set) this.resetCharsets();
            break;
          case 12:
            this.cursorBlink = set;
            break;
          case 25:
            this.cursorVisible = set;
            break;
          case 1006:
            if (set) this.mouseEncoding = 'sgr';
            else this.mouseEncoding = 'default';
            break;
          case 1016:
            if (set) this.mouseEncoding = 'sgr-pixels';
            else this.mouseEncoding = 'default';
            break;
        }
      }
    };

  private ansiMode =
    (set: boolean) =>
    (params: (number | number[])[]): void => {
      if (topLevel(params).includes(20)) this.newlineMode = set;
    };

  private decscusr = (params: (number | number[])[]): void => {
    const top = topLevel(params);
    const ps = top.length === 0 ? 1 : top[0]!;
    if (ps === 0) {
      this.cursorShape = undefined;
      this.cursorShapeBlink = undefined;
      return;
    }
    if (ps === 1 || ps === 2) this.cursorShape = 'block';
    else if (ps === 3 || ps === 4) this.cursorShape = 'underline';
    else if (ps === 5 || ps === 6) this.cursorShape = 'bar';
    this.cursorShapeBlink = ps % 2 === 1;
  };

  private decstbm = (params: (number | number[])[]): void => {
    const top = topLevel(params);
    const rows = this.term.rows;
    const t = top[0] || 1;
    let bottom = top[1] ?? 0;
    if (top.length < 2 || bottom > rows || bottom === 0) bottom = rows;
    if (bottom > t) {
      this.activeBuffer.scrollTop = t - 1;
      this.activeBuffer.scrollBottom = bottom - 1;
    }
  };

  private tbc = (params: (number | number[])[]): void => {
    const ps = topLevel(params)[0] ?? 0;
    if (ps === 0) this.activeBuffer.tabs.delete(this.term.buffer.active.cursorX);
    else if (ps === 3) this.activeBuffer.tabs.clear();
  };

  private hts = (): void => {
    this.activeBuffer.tabs.add(this.term.buffer.active.cursorX);
  };

  /** DECSTR (InputHandler.softReset). Mouse encoding and tab stops survive it. */
  private decstr = (): void => {
    this.cursorVisible = true;
    this.cursorShape = undefined;
    this.cursorShapeBlink = undefined;
    this.resetCharsets();
    this.activeBuffer.scrollTop = 0;
    this.activeBuffer.scrollBottom = this.term.rows - 1;
  };

  /**
   * RIS (headless/browser `Terminal.reset`). Options (cursorBlink, convertEol), the title and,
   * in xterm 6, the cursor visibility survive it.
   */
  private ris = (): void => {
    this.mouseEncoding = 'default';
    this.cursorShape = undefined;
    this.cursorShapeBlink = undefined;
    this.resetCharsets();
    this.buffers.normal = this.freshBuffer();
    this.buffers.alternate = this.freshBuffer();
  };

  private defaultCharset = (): void => {
    this.charsets[0] = DEFAULT_CHARSET;
  };
}
