/**
 * Test harness for the emulator golden tests: fixture loading, seeded chunking, a state probe
 * (public buffer API plus xterm internals that the public API does not expose) and a precise
 * diff. Reading internals is fine here: the version is pinned and this is test-only code.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { ModeState } from '@termavox/terminal-config';
import type { Terminal } from '@xterm/headless';
import { HeadlessEmulator } from '../../src/emulator/headless-emulator.ts';

export const FIXTURE_DIR = new URL('../fixtures/terminal/', import.meta.url);
export const SCROLLBACK = 1_000;

export type StreamEvent = Uint8Array | string | { resize: [number, number] };

export interface Scenario {
  name: string;
  cols: number;
  rows: number;
  events: StreamEvent[];
}

interface FixtureFile {
  name: string;
  cols: number;
  rows: number;
  events: ({ data: string } | { resize: [number, number] })[];
}

/** Real recordings (see fixtures/terminal/record/record.py). */
export function loadRecordedScenarios(): Scenario[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const fx = JSON.parse(readFileSync(new URL(f, FIXTURE_DIR), 'utf8')) as FixtureFile;
      return {
        name: `recorded:${fx.name}`,
        cols: fx.cols,
        rows: fx.rows,
        events: fx.events.map((e) =>
          'data' in e ? new Uint8Array(Buffer.from(e.data, 'base64')) : { resize: e.resize },
        ),
      };
    });
}

/** mulberry32: small deterministic PRNG so failures reproduce from the seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Splits bytes into random chunks; by default mostly tiny ones so that UTF-8 and escape
 * sequences get cut often.
 */
export function randomChunks(bytes: Uint8Array, rand: () => number, tiny = 0.7): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    const size = rand() < tiny ? 1 + Math.floor(rand() * 6) : 1 + Math.floor(rand() * 512);
    out.push(bytes.subarray(i, i + size));
    i += size;
  }
  return out;
}

export interface SplitStats {
  insideUtf8: number;
  insideEscape: number;
}

/** Counts chunk boundaries that fall inside a UTF-8 sequence or right after an ESC introducer. */
export function splitStats(chunks: Uint8Array[]): SplitStats {
  const stats = { insideUtf8: 0, insideEscape: 0 };
  for (let k = 0; k + 1 < chunks.length; k++) {
    const next = chunks[k + 1]![0]!;
    const prev = chunks[k]![chunks[k]!.length - 1]!;
    if ((next & 0xc0) === 0x80) stats.insideUtf8++;
    if (prev === 0x1b || (prev === 0x5b && chunks[k]!.length > 1)) stats.insideEscape++;
  }
  return stats;
}

const encoder = new TextEncoder();
export const bytes = (s: string): Uint8Array => encoder.encode(s);

export function newEmulator(cols: number, rows: number, answerQueries = false): HeadlessEmulator {
  return new HeadlessEmulator({ cols, rows, scrollback: SCROLLBACK, answerQueries });
}

/** Feeds a scenario, optionally re-chunked; resizes go through the emulator's write queue. */
export function feed(em: HeadlessEmulator, scenario: Scenario, rand?: () => number): Uint8Array[] {
  const written: Uint8Array[] = [];
  for (const ev of scenario.events) {
    if (typeof ev === 'object' && 'resize' in ev) {
      em.resize({ cols: ev.resize[0], rows: ev.resize[1] });
      continue;
    }
    const data = typeof ev === 'string' ? bytes(ev) : ev;
    const chunks = rand ? randomChunks(data, rand) : [data];
    for (const c of chunks) em.write(c);
    written.push(...chunks);
  }
  return written;
}

/** Restores a snapshot the way the browser does: fresh terminal → resize → write. */
export async function restore(snapshot: Uint8Array, cols: number, rows: number) {
  const em = newEmulator(80, 24);
  em.resize({ cols, rows });
  em.write(snapshot);
  await em.flush();
  return em;
}

const CM_P16 = 0x1000000;
const CM_P256 = 0x2000000;

/**
 * SerializeAddon writes 256-color indexes 0–15 (`38;5;n`) as 16-color SGR (`3n`/`9n`), so the
 * color mode changes while the palette entry stays the same (ADR-0001, "not restored"). The
 * probe treats both encodings of those indexes as equal.
 */
function colorMode(mode: number, color: number): number {
  return mode === CM_P256 && color < 16 ? CM_P16 : mode;
}

type Json = string | number | boolean | null | undefined | Json[] | { [k: string]: Json };

const FLAG_NAMES = [
  'bold',
  'italic',
  'underline',
  'inverse',
  'dim',
  'strike',
  'blink',
  'hidden',
  'over',
];

/**
 * One string per cell: `chars|width|fgMode:fg|bgMode:bg|flags` (cheap to build and compare).
 * `exact` keeps everything; otherwise the two documented SerializeAddon gaps are normalized
 * (see `colorMode` and the hidden cells below).
 */
function bufferView(term: Terminal, which: 'normal' | 'alternate', exact: boolean): Json {
  const mode = exact ? (m: number) => m : colorMode;
  const buf = term.buffer[which];
  const cell = buf.getNullCell();
  const lines: Json[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)!;
    const cells: string[] = [];
    // Cells hidden beyond the right edge (alternate buffer after a shrink) are not restorable.
    const width = exact ? line.length : Math.min(line.length, term.cols);
    for (let x = 0; x < width; x++) {
      line.getCell(x, cell);
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
        .map((on, i) => (on ? FLAG_NAMES[i] : ''))
        .filter(Boolean)
        .join(',');
      cells.push(
        `${cell.getChars()}|${cell.getWidth()}|` +
          `${mode(cell.getFgColorMode(), cell.getFgColor())}:${cell.getFgColor()}|` +
          `${mode(cell.getBgColorMode(), cell.getBgColor())}:${cell.getBgColor()}|${flags}`,
      );
    }
    lines.push({ wrapped: line.isWrapped, cells });
  }
  return { length: buf.length, baseY: buf.baseY, viewportY: buf.viewportY, lines };
}

// biome-ignore lint/suspicious/noExplicitAny: test-only access to xterm internals
type Core = any;

function charsetKey(c: unknown): string {
  return c === undefined ? 'US-ASCII' : JSON.stringify(c).slice(0, 24);
}

/** xterm state that SerializeAddon does not cover, read from internals. */
function internals(term: Terminal): Json {
  const core: Core = (term as unknown as { _core: Core })._core;
  const cols = term.cols;
  const bufferInternals = (b: Core): Json => ({
    tabs: Object.keys(b.tabs)
      .map(Number)
      .filter((t) => b.tabs[t] && t < cols)
      .sort((x, y) => x - y),
    scrollTop: b.scrollTop,
    scrollBottom: b.scrollBottom,
  });
  const cs = core._charsetService;
  const attr = core._inputHandler._curAttrData;
  return {
    mouseProtocol: core.coreMouseService.activeProtocol,
    mouseEncoding: core.coreMouseService.activeEncoding,
    decPrivateModes: { ...core.coreService.decPrivateModes },
    ansiModes: { ...core.coreService.modes },
    cursorHidden: core.coreService.isCursorHidden,
    optionCursorBlink: core.optionsService.rawOptions.cursorBlink,
    optionConvertEol: core.optionsService.rawOptions.convertEol,
    title: core._inputHandler._windowTitle,
    charsets: [0, 1, 2, 3].map((g) => charsetKey(cs._charsets[g])),
    glevel: cs.glevel,
    activeCharset: charsetKey(cs.charset),
    currentAttr: { fg: attr.fg, bg: attr.bg },
    normal: bufferInternals(core.buffers.normal),
    alternate: bufferInternals(core.buffers.alt),
  };
}

export interface Probe {
  size: Json;
  active: Json;
  cursor: Json;
  modes: Json;
  internals: Json;
  tracker: ModeState;
  normal: Json;
  alternate: Json;
}

/**
 * Full state of an emulator. Use `exact` between two live emulators fed the same bytes; the
 * default normalizes what SerializeAddon cannot restore (for restored-vs-live comparisons).
 */
export function probe(em: HeadlessEmulator, exact = false): Probe {
  const t = em.terminal;
  return {
    size: { cols: t.cols, rows: t.rows },
    active: t.buffer.active.type,
    cursor: { x: t.buffer.active.cursorX, y: t.buffer.active.cursorY },
    modes: { ...t.modes },
    internals: internals(t),
    tracker: em.modeTracker.state(),
    normal: bufferView(t, 'normal', exact),
    alternate: bufferView(t, 'alternate', exact),
  };
}

/** Field-by-field diff; returns human-readable mismatches (empty = identical). */
export function diff(a: unknown, b: unknown, path = '', out: string[] = [], limit = 25): string[] {
  if (path === '' && JSON.stringify(a) === JSON.stringify(b)) return out; // fast path
  if (out.length >= limit) return out;
  if (Object.is(a, b)) return out;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      diff(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
        out,
        limit,
      );
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  return out;
}
