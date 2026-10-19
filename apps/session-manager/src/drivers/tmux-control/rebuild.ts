/**
 * Snapshot capture and emulator rebuild for tmux control mode (plan §6.8, ADR-0003).
 *
 * Attaching to tmux sends no screen content, so the driver captures the pane with one batch of
 * commands (they run back to back, between two reads of the pane's output) and turns the reply
 * into bytes that rebuild an equivalent emulator from scratch. Everything here is pure, so it is
 * testable from recorded captures.
 */

import { hostMessage, hostText } from '../../core/host-text.ts';
import type { Emulator } from '../../core/types.ts';
import type { CommandResult } from './correlator.ts';
import { TmuxDesyncError } from './correlator.ts';
import { concatBytes } from './lines.ts';
import { unescapeOutput } from './unescape.ts';

/** STATE_FORMAT fields in order; `#{q:pane_title}` follows them, last (titles may hold TABs). */
const STATE_FIELDS = [
  'pane_id',
  'pane_width',
  'pane_height',
  'history_size',
  'cursor_x',
  'cursor_y',
  'alternate_on',
  'alternate_saved_x',
  'alternate_saved_y',
  'scroll_region_upper',
  'scroll_region_lower',
  'cursor_flag',
  'insert_flag',
  'keypad_cursor_flag',
  'keypad_flag',
  'wrap_flag',
  'origin_flag',
  'mouse_standard_flag',
  'mouse_button_flag',
  'mouse_all_flag',
  'mouse_sgr_flag',
  'mouse_utf8_flag',
  'pane_in_mode',
  'pane_tabs',
  // Empty before tmux 3.7 (bracket_paste_flag), 3.6 (cursor_*) and 3.8 (pane_private_modes).
  'bracket_paste_flag',
  'cursor_shape',
  'cursor_blinking',
  'pane_private_modes',
  'host',
  'host_short',
] as const;

type StateField = (typeof STATE_FIELDS)[number];

/**
 * The pane state query (plan §6.8). TAB-separated, no `%` (display-message runs strftime on its
 * template first, ADR-0002); unknown variables expand to empty on older tmux versions.
 */
export const STATE_FORMAT = [...STATE_FIELDS.map((f) => `#{${f}}`), '#{q:pane_title}'].join('\t');

/** Index of each command's reply block in a snapshot batch (sentinel excluded). */
export const SNAPSHOT_BLOCKS = {
  history: 0,
  screen: 1,
  screenRows: 2,
  savedMain: 3,
  wrapProbe: 4,
  state: 5,
  pending: 6,
} as const;

/**
 * The snapshot batch for one pane, sent as ONE line (with the nonce sentinel appended by
 * `CommandCorrelator.sendBatch`). History and screen are captured separately because `-J`
 * changes line counts; `-a -q` is the saved main screen while the alternate screen is active;
 * the unjoined screen rows rebuild a pending wrap; the `-S -1 -E 0 -J` probe tells whether the
 * last history line is soft-wrapped into the first screen row (one line back means joined);
 * `-P -C` is the escape sequence still pending in tmux's parser.
 */
export function snapshotCommands(paneId: number): string[] {
  if (!Number.isInteger(paneId) || paneId < 0) throw new RangeError(`invalid pane id: ${paneId}`);
  const t = `-t %${paneId}`;
  return [
    `capture-pane -p -e -J -N ${t} -S - -E -1`,
    `capture-pane -p -e -J -N ${t}`,
    `capture-pane -p -e -N ${t}`,
    `capture-pane -p -e -J -N -a -q ${t}`,
    `capture-pane -p -J ${t} -S -1 -E 0`,
    `display-message -p ${t} '${STATE_FORMAT}'`,
    `capture-pane -p -P -C ${t}`,
  ];
}

export type CursorShape = 'default' | 'block' | 'underline' | 'bar';

/** The parsed STATE_FORMAT reply. `null` = not reported by this tmux version. */
export interface PaneState {
  paneId: number;
  width: number;
  height: number;
  historySize: number;
  /** `cursorX === width` means a pending wrap (tmux keeps cx = sx after the last column). */
  cursorX: number;
  cursorY: number;
  alternateOn: boolean;
  /** Cursor saved by `?1049h` (null when none was saved). */
  altSavedX: number | null;
  altSavedY: number | null;
  scrollUpper: number;
  scrollLower: number;
  cursorVisible: boolean;
  insertMode: boolean;
  appCursorKeys: boolean;
  appKeypad: boolean;
  autoWrap: boolean;
  originMode: boolean;
  mouseStandard: boolean;
  mouseButton: boolean;
  mouseAll: boolean;
  mouseSgr: boolean;
  mouseUtf8: boolean;
  inMode: boolean;
  tabs: number[];
  bracketPaste: boolean | null;
  cursorShape: CursorShape | null;
  cursorBlinking: boolean | null;
  /** DEC private modes that are set (tmux 3.8 `pane_private_modes`). */
  privateModes: ReadonlySet<number> | null;
  host: string;
  hostShort: string;
  title: string;
}

export interface PaneCapture {
  state: PaneState;
  /** Joined history lines (empty when `history_size` is 0). */
  history: Uint8Array[];
  /** Joined screen lines (the alternate screen when it is active). */
  screen: Uint8Array[];
  /** Unjoined screen rows, one per pane row. */
  screenRows: Uint8Array[];
  /** Joined saved main screen while the alternate screen is active, else null. */
  savedMain: Uint8Array[] | null;
  /** The last history line continues (soft wrap) on the first row below it. */
  wrappedIntoScreen: boolean;
  /** Bytes of an escape sequence tmux's parser is in the middle of. */
  pending: Uint8Array;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);
/** tmux prints UINT_MAX for an unset saved cursor. */
const MAX_COORD = 100_000;

/** `message` may quote the reply (host text): cleaned and capped like any such message. */
function fail(message: string): never {
  throw new TmuxDesyncError(hostMessage('snapshot: ', message));
}

/** Parses the STATE_FORMAT reply line. Throws TmuxDesyncError when it is malformed. */
export function parsePaneState(line: string): PaneState {
  const fields = line.split('\t');
  if (fields.length < STATE_FIELDS.length + 1) fail(`state has ${fields.length} fields`);
  const raw = Object.fromEntries(STATE_FIELDS.map((f, i) => [f, fields[i]!])) as Record<
    StateField,
    string
  >;
  const int = (field: StateField): number => {
    const value = raw[field];
    if (!/^\d+$/.test(value)) fail(`${field}=${JSON.stringify(value)}`);
    return Number(value);
  };
  const coord = (field: StateField): number | null => {
    const value = raw[field];
    return /^\d+$/.test(value) && Number(value) < MAX_COORD ? Number(value) : null;
  };
  const flag = (field: StateField): boolean => {
    if (raw[field] !== '0' && raw[field] !== '1') fail(`${field}=${JSON.stringify(raw[field])}`);
    return raw[field] === '1';
  };
  const optionalFlag = (field: StateField): boolean | null =>
    raw[field] === '' ? null : raw[field] === '1';
  const list = (value: string): number[] =>
    value === ''
      ? []
      : value
          .split(',')
          .filter((v) => /^\d+$/.test(v))
          .map(Number);

  const paneMatch = /^%(\d+)$/.exec(raw.pane_id);
  if (!paneMatch) fail(`pane_id=${JSON.stringify(raw.pane_id)}`);
  const shape = raw.cursor_shape;
  const cursorShape: CursorShape | null =
    shape === 'block' || shape === 'underline' || shape === 'bar' || shape === 'default'
      ? shape
      : null;
  // pane_private_modes is empty both when unknown and when every mode is off; cursor_shape
  // (also a newer variable) disambiguates.
  const privateModes =
    raw.pane_private_modes === '' && cursorShape === null
      ? null
      : new Set(list(raw.pane_private_modes));
  const state: PaneState = {
    paneId: Number(paneMatch[1]),
    width: int('pane_width'),
    height: int('pane_height'),
    historySize: int('history_size'),
    cursorX: int('cursor_x'),
    cursorY: int('cursor_y'),
    alternateOn: flag('alternate_on'),
    altSavedX: coord('alternate_saved_x'),
    altSavedY: coord('alternate_saved_y'),
    scrollUpper: int('scroll_region_upper'),
    scrollLower: int('scroll_region_lower'),
    cursorVisible: flag('cursor_flag'),
    insertMode: flag('insert_flag'),
    appCursorKeys: flag('keypad_cursor_flag'),
    appKeypad: flag('keypad_flag'),
    autoWrap: flag('wrap_flag'),
    originMode: flag('origin_flag'),
    mouseStandard: flag('mouse_standard_flag'),
    mouseButton: flag('mouse_button_flag'),
    mouseAll: flag('mouse_all_flag'),
    mouseSgr: flag('mouse_sgr_flag'),
    mouseUtf8: flag('mouse_utf8_flag'),
    inMode: flag('pane_in_mode'),
    tabs: list(raw.pane_tabs),
    bracketPaste: optionalFlag('bracket_paste_flag'),
    cursorShape,
    cursorBlinking: optionalFlag('cursor_blinking'),
    privateModes,
    host: raw.host,
    hostShort: raw.host_short,
    // #{q:} backslash-escapes shell specials (3.8 also braces and backslashes).
    title: fields.slice(STATE_FIELDS.length).join('\t').replace(/\\(.)/g, '$1'),
  };
  if (state.width < 1 || state.height < 1) fail(`pane size ${state.width}x${state.height}`);
  if (state.cursorY >= state.height || state.cursorX > state.width) fail('cursor outside pane');
  return state;
}

/** Parses a snapshot batch reply (the blocks of `snapshotCommands`, sentinel excluded). */
export function parseCapture(blocks: readonly CommandResult[]): PaneCapture {
  const count = Object.keys(SNAPSHOT_BLOCKS).length;
  if (blocks.length !== count) fail(`expected ${count} reply blocks, got ${blocks.length}`);
  const failed = blocks.findIndex((b) => !b.ok);
  if (failed !== -1) fail(`command ${failed} failed: ${hostText(blocks[failed]!.lines)}`);
  const block = (key: keyof typeof SNAPSHOT_BLOCKS): Uint8Array[] =>
    blocks[SNAPSHOT_BLOCKS[key]]!.lines;
  const stateLines = block('state');
  if (stateLines.length !== 1) fail(`state reply has ${stateLines.length} lines`);
  const state = parsePaneState(decoder.decode(stateLines[0]));
  // With no history, `-S - -E -1` clamps to the first screen row: ignore it.
  const history = state.historySize > 0 ? block('history') : [];
  const screen = block('screen');
  const screenRows = block('screenRows');
  if (screenRows.length !== state.height) {
    fail(`screen has ${screenRows.length} rows, pane has ${state.height}`);
  }
  return {
    state,
    history,
    screen,
    screenRows,
    savedMain: state.alternateOn ? block('savedMain') : null,
    wrappedIntoScreen: state.historySize > 0 && block('wrapProbe').length === 1,
    pending: unescapeOutput(concatLines(block('pending'))),
  };
}

function concatLines(lines: readonly Uint8Array[]): Uint8Array {
  if (lines.length === 0) return EMPTY;
  if (lines.length === 1) return lines[0]!;
  const parts: Uint8Array[] = [];
  lines.forEach((line, i) => {
    if (i > 0) parts.push(LF);
    parts.push(line);
  });
  return concatBytes(parts);
}

const ESC = 0x1b;
const SO = 0x0e;
const SI = 0x0f;
const BEL = 0x07;
const LF = new Uint8Array([0x0a]);
const SGR_RESET = '\x1b[0m';
const LINK_CLOSE = '\x1b]8;;\x1b\\';

/**
 * The SGR pen, shift state and hyperlink at a point of a `capture-pane -e` stream. tmux emits
 * attribute changes relative to the previous cell, across lines, so the pen at the end of a line
 * is what the next line starts with. The rebuild resets it before each CRLF (so a scroll does not
 * paint the new line with the background colour) and re-applies it after.
 */
export class PenTracker {
  #flags = new Set<number>();
  /** '' or the underline parameter ('4', '4:3', '21'). */
  #underline = '';
  #fg = '';
  #bg = '';
  #ul = '';
  #shiftOut = false;
  #link: string | null = null;

  get shiftOut(): boolean {
    return this.#shiftOut;
  }

  clone(): PenTracker {
    const copy = new PenTracker();
    copy.#flags = new Set(this.#flags);
    copy.#underline = this.#underline;
    copy.#fg = this.#fg;
    copy.#bg = this.#bg;
    copy.#ul = this.#ul;
    copy.#shiftOut = this.#shiftOut;
    copy.#link = this.#link;
    return copy;
  }

  get linkOpen(): boolean {
    return this.#link !== null;
  }

  isDefault(): boolean {
    return this.#flags.size === 0 && !this.#underline && !this.#fg && !this.#bg && !this.#ul;
  }

  /** Feeds bytes of the capture stream (cells, SGR, SO/SI, OSC 8). */
  feed(bytes: Uint8Array): void {
    // UTF-8 continuation and lead bytes are >= 0x80, so these values are always controls.
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i]!;
      if (b === ESC) {
        i = this.#escape(bytes, i);
        continue;
      }
      if (b === SO) this.#shiftOut = true;
      else if (b === SI) this.#shiftOut = false;
      i++;
    }
  }

  /** SGR that reproduces the pen from any state (`\e[0;…m`), or '' when it is the default. */
  sgr(): string {
    if (this.isDefault()) return '';
    const params = ['0', ...[...this.#flags].sort((a, b) => a - b).map(String)];
    if (this.#underline) params.push(this.#underline);
    if (this.#fg) params.push(this.#fg);
    if (this.#bg) params.push(this.#bg);
    if (this.#ul) params.push(this.#ul);
    return `\x1b[${params.join(';')}m`;
  }

  /** Everything needed to continue writing at this point: pen, shift state, open link. */
  restore(): string {
    return this.sgr() + (this.#shiftOut ? '\x0e' : '') + (this.#link ?? '');
  }

  /** Undoes the shift state and closes an open link (end of a capture). */
  close(): string {
    return (this.#shiftOut ? '\x0f' : '') + (this.#link !== null ? LINK_CLOSE : '');
  }

  /** Handles the sequence at `at` (ESC); returns the index right after it. */
  #escape(bytes: Uint8Array, at: number): number {
    const kind = bytes[at + 1];
    if (kind === 0x5b) {
      // CSI: parameters up to the final byte (0x40–0x7e).
      let end = at + 2;
      while (end < bytes.length && (bytes[end]! < 0x40 || bytes[end]! > 0x7e)) end++;
      if (end >= bytes.length) return bytes.length;
      if (bytes[end] === 0x6d) this.#sgr(decoder.decode(bytes.subarray(at + 2, end)));
      return end + 1;
    }
    if (kind === 0x5d) {
      // OSC: up to BEL or ST.
      let end = at + 2;
      while (end < bytes.length && bytes[end] !== BEL && bytes[end] !== ESC) end++;
      const body = decoder.decode(bytes.subarray(at + 2, end));
      const stop = bytes[end] === ESC ? end + 2 : end + 1;
      if (body.startsWith('8;')) {
        const uri = body.slice(body.indexOf(';', 2) + 1);
        this.#link = uri ? decoder.decode(bytes.subarray(at, Math.min(stop, bytes.length))) : null;
      }
      return Math.min(stop, bytes.length);
    }
    return Math.min(at + 2, bytes.length);
  }

  #sgr(text: string): void {
    const params = text === '' ? ['0'] : text.split(';');
    for (let i = 0; i < params.length; i++) {
      const param = params[i]!;
      const [head = '', ...sub] = param.split(':');
      const code = head === '' ? 0 : Number(head);
      if (code === 38 || code === 48 || code === 58) {
        let color: string;
        if (sub.length > 0) {
          color = param;
        } else {
          const take = params[i + 1] === '5' ? 2 : params[i + 1] === '2' ? 4 : 0;
          color = params.slice(i, i + 1 + take).join(';');
          i += take;
        }
        if (code === 38) this.#fg = color;
        else if (code === 48) this.#bg = color;
        else this.#ul = color;
        continue;
      }
      this.#apply(code, sub);
    }
  }

  #apply(code: number, sub: string[]): void {
    const flags = this.#flags;
    if (code === 0) {
      flags.clear();
      this.#underline = this.#fg = this.#bg = this.#ul = '';
    } else if (code === 4) {
      this.#underline = sub.length === 0 ? '4' : sub[0] === '0' ? '' : `4:${sub[0]}`;
    } else if (code === 21) {
      this.#underline = '21';
    } else if (code === 24) {
      this.#underline = '';
    } else if (code === 22) {
      flags.delete(1);
      flags.delete(2);
    } else if ([23, 25, 27, 28, 29].includes(code)) {
      flags.delete(code - 20);
    } else if (code === 55) {
      flags.delete(53);
    } else if ([1, 2, 3, 5, 7, 8, 9, 53].includes(code)) {
      flags.add(code);
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      this.#fg = String(code);
    } else if (code === 39) {
      this.#fg = '';
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      this.#bg = String(code);
    } else if (code === 49) {
      this.#bg = '';
    } else if (code === 59) {
      this.#ul = '';
    }
  }
}

const COLON = 0x3a;

/**
 * Works around a tmux bug (3.2a–3.8): `capture-pane -e` writes every attribute code >= 10 as
 * `a:b` (meant for the underline styles 42–45 → `4:2`…`4:5`), so overline (53) comes back as
 * `5:3`, which terminals read as blink. Rewrites that parameter to `53` in SGR sequences.
 */
export function fixCaptureSgr(line: Uint8Array): Uint8Array {
  if (!line.includes(COLON)) return line;
  const parts: Uint8Array[] = [];
  let copied = 0;
  for (let i = line.indexOf(ESC); i !== -1 && i + 1 < line.length; i = line.indexOf(ESC, i + 1)) {
    if (line[i + 1] !== 0x5b) continue;
    let end = i + 2;
    while (end < line.length && (line[end]! < 0x40 || line[end]! > 0x7e)) end++;
    if (line[end] !== 0x6d) continue;
    const params = decoder.decode(line.subarray(i + 2, end)).split(';');
    if (!params.includes('5:3')) continue;
    parts.push(
      line.subarray(copied, i + 2),
      text(params.map((p) => (p === '5:3' ? '53' : p)).join(';')),
    );
    copied = end;
  }
  if (copied === 0) return line;
  parts.push(line.subarray(copied));
  return concatBytes(parts);
}

/**
 * Drops trailing spaces written with the default pen. tmux 3.2 reports cells up to its line
 * allocation as default spaces (3.4+ stop at the last used cell); writing them would overwrite
 * what the rebuild itself produces there (nothing, or the background a scroll painted), and an
 * erased cell and a space look the same anyway. Spaces with any attribute are content.
 */
function trimDefaultBlanks(line: Uint8Array, pen: PenTracker): Uint8Array {
  let end = line.length;
  while (end > 0 && line[end - 1] === 0x20) end--;
  if (end === line.length) return line;
  const probe = pen.clone();
  probe.feed(line.subarray(0, end));
  return probe.isDefault() && !probe.linkOpen ? line.subarray(0, end) : line;
}

/**
 * Appends capture lines joined by CRLF. The pen is reset before each CRLF and re-applied after
 * it; at the end the shift state is undone and an open link closed (a new capture starts from
 * the default pen). `softWrapAfter`: the last line continues on the next row (keep it whole).
 */
function writeLines(out: Uint8Array[], lines: readonly Uint8Array[], softWrapAfter = false): void {
  const pen = new PenTracker();
  lines.forEach((raw, i) => {
    const last = i === lines.length - 1;
    const fixed = fixCaptureSgr(raw);
    const line = last && softWrapAfter ? fixed : trimDefaultBlanks(fixed, pen);
    out.push(line);
    pen.feed(line);
    if (!last) out.push(text(pen.isDefault() ? '\r\n' : `${SGR_RESET}\r\n${pen.sgr()}`));
  });
  out.push(text(SGR_RESET + pen.close()));
}

function text(s: string): Uint8Array {
  return encoder.encode(s);
}

function cup(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`;
}

/** Tab stops as `CSI 3 g` + HTS per stop, or '' for tmux's default stops (every 8 from 8). */
function tabStops(state: PaneState): string {
  const defaults: number[] = [];
  for (let x = 8; x < state.width; x += 8) defaults.push(x);
  if (state.tabs.length === defaults.length && state.tabs.every((t, i) => t === defaults[i])) {
    return '';
  }
  return `\x1b[3g${state.tabs
    .filter((t) => t < state.width)
    .map((t) => `\x1b[${t + 1}G\x1bH`)
    .join('')}\r`;
}

const SHAPE_PS: Record<'block' | 'underline' | 'bar', number> = { block: 2, underline: 4, bar: 6 };

/** Modes that do not move the cursor, written after the content (plan §6.8 step 3). */
function modeSequences(state: PaneState): string {
  let m = '';
  if (!state.cursorVisible) m += '\x1b[?25l';
  if (state.appCursorKeys) m += '\x1b[?1h';
  if (state.appKeypad) m += '\x1b=';
  if (state.mouseStandard) m += '\x1b[?1000h';
  if (state.mouseButton) m += '\x1b[?1002h';
  if (state.mouseAll) m += '\x1b[?1003h';
  if (state.mouseUtf8) m += '\x1b[?1005h';
  if (state.mouseSgr) m += '\x1b[?1006h';
  if (state.privateModes?.has(1004)) m += '\x1b[?1004h';
  // Unknown before tmux 3.7: shells at a prompt (bash ≥ 5.1, zsh, fish) enable bracketed paste,
  // full-screen applications usually do not.
  if (state.bracketPaste ?? !state.alternateOn) m += '\x1b[?2004h';
  if (state.insertMode) m += '\x1b[4h';
  if (!state.autoWrap) m += '\x1b[?7l';
  if (state.cursorShape && state.cursorShape !== 'default') {
    m += `\x1b[${SHAPE_PS[state.cursorShape] - (state.cursorBlinking ? 1 : 0)} q`;
  }
  return m;
}

/** A title worth restoring: tmux reports the host name for panes that never set one. */
function titleSequence(state: PaneState): string {
  // C0, DEL and C1 controls (e.g. ST) would end or corrupt the OSC sequence.
  const title = [...state.title].filter((ch) => ch >= ' ' && (ch < '\x7f' || ch > '\x9f')).join('');
  if (!title || title === state.host || title === state.hostShort) return '';
  return `\x1b]2;${title}\x07`;
}

/**
 * Bytes that rebuild the captured pane in a fresh emulator of the pane's size (plan §6.8 with
 * the ADR-0003 corrections):
 *  1. G1 = DEC special graphics, so cells tmux reports with SO/SI draw lines (the tmux-256color
 *     `enacs` default);
 *  2. history lines, then screen lines, joined by CRLF with the pen re-applied per line (a soft
 *     wrap into the screen is kept by not breaking the line); with the alternate screen active:
 *     history + saved main screen, CUP to the saved cursor, `?1049h`, alternate rows;
 *  3. modes, scroll region (before CUP: DECSTBM homes the cursor), origin mode, title;
 *  4. CUP to the cursor (relative to the scroll region with origin mode), or, for a pending
 *     wrap, the cursor row printed again so the cursor ends past the last column;
 *  5. the escape sequence pending in tmux's parser, else `carry` (an incomplete UTF-8 character
 *     at the end of the dropped output, which tmux holds outside its grid).
 * The pen ends at the default: tmux does not expose it.
 */
export function rebuildBytes(capture: PaneCapture, carry: Uint8Array = EMPTY): Uint8Array {
  const s = capture.state;
  const out: Uint8Array[] = [text('\x1b)0')];
  const tabs = tabStops(s);
  const historyBreak = capture.wrappedIntoScreen ? SGR_RESET : `${SGR_RESET}\r\n`;
  if (!s.alternateOn) {
    if (tabs) out.push(text(tabs));
    writeLines(out, capture.history, capture.wrappedIntoScreen);
    if (capture.history.length > 0) out.push(text(historyBreak));
    writeLines(out, capture.screen);
  } else {
    writeLines(out, capture.history, capture.wrappedIntoScreen);
    if (capture.history.length > 0) out.push(text(historyBreak));
    writeLines(out, capture.savedMain ?? []);
    let enter = SGR_RESET;
    if (s.altSavedX !== null && s.altSavedY !== null) {
      enter += cup(Math.min(s.altSavedY, s.height - 1), Math.min(s.altSavedX, s.width - 1));
    }
    out.push(text(`${enter}\x1b[?1049h${tabs}\x1b[H`));
    writeLines(out, capture.screen);
  }
  let tail = SGR_RESET + modeSequences(s);
  const region = s.scrollUpper !== 0 || s.scrollLower !== s.height - 1;
  if (region) tail += `\x1b[${s.scrollUpper + 1};${s.scrollLower + 1}r`;
  if (s.originMode) tail += '\x1b[?6h';
  tail += titleSequence(s);
  const rowOf = (y: number): number => (s.originMode ? Math.max(y - s.scrollUpper, 0) : y);
  const cursorRow = capture.screenRows[s.cursorY];
  if (s.cursorX >= s.width && s.autoWrap && cursorRow) {
    // Pending wrap: print the cursor row again from its first column; the cursor then sits past
    // the last column exactly as in tmux, and the next character wraps.
    const row = fixCaptureSgr(cursorRow);
    const pen = new PenTracker();
    for (let y = 0; y < s.cursorY; y++) pen.feed(fixCaptureSgr(capture.screenRows[y]!));
    out.push(
      text(`${tail}${s.insertMode ? '\x1b[4l' : ''}${cup(rowOf(s.cursorY), 0)}${pen.restore()}`),
    );
    out.push(row);
    pen.feed(row);
    out.push(text(`${SGR_RESET}${pen.close()}${s.insertMode ? '\x1b[4h' : ''}`));
  } else {
    out.push(text(tail + cup(rowOf(s.cursorY), Math.min(s.cursorX, s.width - 1))));
  }
  out.push(capture.pending.length > 0 ? capture.pending : carry);
  return concatBytes(out);
}

/**
 * Fills a fresh emulator (from `DriverContext.replaceState`) with the captured pane; resolves
 * with the number of bytes written once the emulator has parsed them.
 */
export async function rebuild(
  fresh: Emulator,
  capture: PaneCapture,
  carry?: Uint8Array,
): Promise<number> {
  const { width, height } = capture.state;
  if (fresh.cols !== width || fresh.rows !== height) fresh.resize({ cols: width, rows: height });
  const bytes = rebuildBytes(capture, carry);
  fresh.write(bytes);
  await fresh.flush();
  return bytes.byteLength;
}
