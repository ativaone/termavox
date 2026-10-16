/**
 * Compares an emulator rebuilt from a tmux capture with a live one (fed the pane's raw output),
 * cell by cell, ignoring only the state documented as unrecoverable in ADR-0003:
 *  - scrollback above the shorter of the two histories (tmux trims 10 % at a time; 3.2 also
 *    pushes cleared screens into history): the comparison is bottom-aligned;
 *  - erased vs space cells ('' vs ' '): tmux reports both as spaces;
 *  - the current SGR pen, G0–G3 charsets and the DECSC saved cursor: never compared;
 *  - modes the tmux version does not report (`unknown`).
 */
import type { IBuffer, IBufferCell, Terminal } from '@xterm/headless';
import type { HeadlessEmulator } from '../../src/emulator/headless-emulator.ts';

export interface UnknownModes {
  /** tmux < 3.7: bracket_paste_flag is not reported (heuristic). */
  bracketedPaste?: boolean;
  /** tmux < 3.8: focus reporting (?1004) is not reported. */
  focus?: boolean;
  /** tmux < 3.6: cursor style (DECSCUSR) is not reported. */
  cursorStyle?: boolean;
}

/** Same tmux version gates as the rebuild (§6.2). */
export function unknownModesFor(version: { major: number; minor: number }): UnknownModes {
  const v = version.major * 100 + version.minor;
  return { bracketedPaste: v < 307, focus: v < 308, cursorStyle: v < 306 };
}

function cellKey(cell: IBufferCell): string {
  const flags = [
    cell.isBold(),
    cell.isItalic(),
    cell.isUnderline(),
    cell.isInverse(),
    cell.isDim(),
    cell.isStrikethrough(),
    cell.isBlink(),
    cell.isInvisible(),
    cell.isOverline(),
  ]
    .map((on) => (on ? '1' : '0'))
    .join('');
  return (
    `${cell.getChars() || ' '}|${cell.getWidth()}|` +
    `${cell.getFgColorMode()}:${cell.getFgColor()}|` +
    `${cell.getBgColorMode()}:${cell.getBgColor()}|${flags}`
  );
}

interface Sink {
  diffs: string[];
  /** Soft-wrap flag differences on lines whose cells are equal (see compareEmulators). */
  wrapDiffs: string[];
}

function lineDiff(
  label: string,
  a: IBuffer,
  ay: number,
  b: IBuffer,
  by: number,
  cols: number,
  sink: Sink,
): void {
  const out = sink.diffs;
  const la = a.getLine(ay);
  const lb = b.getLine(by);
  if (!la || !lb) {
    out.push(`${label}: missing line (${!!la}/${!!lb})`);
    return;
  }
  if (la.isWrapped !== lb.isWrapped) {
    sink.wrapDiffs.push(`${label}: isWrapped ${la.isWrapped} != ${lb.isWrapped}`);
  }
  const ca = a.getNullCell();
  const cb = b.getNullCell();
  for (let x = 0; x < cols; x++) {
    la.getCell(x, ca);
    lb.getCell(x, cb);
    const ka = cellKey(ca);
    const kb = cellKey(cb);
    if (ka !== kb) {
      out.push(
        `${label} col ${x}: ${JSON.stringify(ka)} != ${JSON.stringify(kb)} ` +
          `| live ${JSON.stringify(la.translateToString(true))} | rebuilt ${JSON.stringify(lb.translateToString(true))}`,
      );
      return; // one diff per line is enough
    }
  }
}

function bufferDiff(name: string, a: IBuffer, b: IBuffer, t: Terminal, sink: Sink): void {
  for (let r = 0; r < t.rows; r++) {
    lineDiff(`${name} row ${r}`, a, a.baseY + r, b, b.baseY + r, t.cols, sink);
  }
  const overlap = Math.min(a.baseY, b.baseY);
  for (let i = 1; i <= overlap; i++) {
    lineDiff(`${name} scrollback -${i}`, a, a.baseY - i, b, b.baseY - i, t.cols, sink);
  }
}

export interface CompareResult {
  /** Cell, cursor and mode differences: must be empty. */
  diffs: string[];
  /**
   * Soft-wrap flag differences (documented in ADR-0003): xterm clears `isWrapped` on a row an
   * explicit LF moves onto, tmux keeps a stale wrapped flag when a row that used to wrap is
   * written over (e.g. a shell redrawing mid-screen). Cells are equal.
   */
  wrapDiffs: string[];
  /** Scrollback lines compared (bottom-aligned overlap of the active normal buffers). */
  scrollbackCompared: number;
  liveScrollback: number;
  rebuiltScrollback: number;
}

export function compareEmulators(
  live: HeadlessEmulator,
  rebuilt: HeadlessEmulator,
  unknown: UnknownModes = {},
  limit = 20,
): CompareResult {
  const sink: Sink = { diffs: [], wrapDiffs: [] };
  const out = sink.diffs;
  const a = live.terminal;
  const b = rebuilt.terminal;
  const result = (): CompareResult => ({
    diffs: out.slice(0, limit),
    wrapDiffs: sink.wrapDiffs.slice(0, limit),
    scrollbackCompared: Math.min(a.buffer.normal.baseY, b.buffer.normal.baseY),
    liveScrollback: a.buffer.normal.baseY,
    rebuiltScrollback: b.buffer.normal.baseY,
  });
  if (a.cols !== b.cols || a.rows !== b.rows) {
    out.push(`size ${a.cols}x${a.rows} != ${b.cols}x${b.rows}`);
    return result();
  }
  const type = a.buffer.active.type;
  if (type !== b.buffer.active.type) out.push(`active buffer ${type} != ${b.buffer.active.type}`);
  const cursor = (t: Terminal): string => `${t.buffer.active.cursorX},${t.buffer.active.cursorY}`;
  if (cursor(a) !== cursor(b)) out.push(`cursor ${cursor(a)} != ${cursor(b)}`);
  bufferDiff('normal', a.buffer.normal, b.buffer.normal, a, sink);
  if (type === 'alternate')
    bufferDiff('alternate', a.buffer.alternate, b.buffer.alternate, a, sink);

  const modes = (t: Terminal): Record<string, unknown> => {
    const m: Record<string, unknown> = { ...t.modes };
    delete m.reverseWraparoundMode; // not tracked by tmux
    delete m.synchronizedOutputMode; // not reported by tmux
    if (unknown.bracketedPaste) delete m.bracketedPasteMode;
    if (unknown.focus) delete m.sendFocusMode;
    return m;
  };
  for (const [key, value] of Object.entries(modes(a))) {
    const other = modes(b)[key];
    if (value !== other) out.push(`mode ${key}: ${String(value)} != ${String(other)}`);
  }

  const sa = live.modeTracker.state();
  const sb = rebuilt.modeTracker.state();
  const tracked = (s: typeof sa): Record<string, unknown> => {
    const active = type === 'alternate' ? s.alternate : s.normal;
    return {
      mouseEncoding: s.mouseEncoding,
      ...(unknown.cursorStyle ? {} : { cursorShape: s.cursorShape, blink: s.cursorShapeBlink }),
      cursorVisible: s.cursorVisible ?? true,
      // Column 0 is ambiguous: tmux never reports it, xterm sets it by default.
      tabStops: active.tabStops.filter((x) => x > 0).join(','),
      scrollRegion: `${active.scrollTop}-${active.scrollBottom}`,
      title: s.title ?? '',
    };
  };
  const ta = tracked(sa);
  const tb = tracked(sb);
  for (const key of Object.keys(ta)) {
    if (JSON.stringify(ta[key]) !== JSON.stringify(tb[key])) {
      out.push(`${key}: ${JSON.stringify(ta[key])} != ${JSON.stringify(tb[key])}`);
    }
  }
  return result();
}

/** Text of the whole normal buffer (scrollback + screen), trimmed per line. */
export function bufferText(em: HeadlessEmulator, which: 'normal' | 'alternate' = 'normal'): string {
  const buffer = em.terminal.buffer[which];
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)!.translateToString(true));
  return lines.join('\n');
}
