import { unescapeOutput } from './unescape.ts';

/** The `<time> <num> <flags>` triple of a `%begin` / `%end` / `%error` guard line. */
export interface BlockGuard {
  time: number;
  num: number;
  /** Bit 0 set: the command came from this control client's stdin. 0: unsolicited. */
  flags: number;
  /** The triple exactly as received; a block only ends on a guard with the same text. */
  raw: string;
}

export type ControlEvent =
  | { type: 'output'; paneId: number; data: Uint8Array }
  | { type: 'extendedOutput'; paneId: number; ageMs: number; data: Uint8Array }
  | { type: 'blockBegin'; guard: BlockGuard }
  | { type: 'blockEnd'; guard: BlockGuard; lines: Uint8Array[] }
  | { type: 'blockError'; guard: BlockGuard; lines: Uint8Array[] }
  | { type: 'exit'; reason?: string }
  | { type: 'pause'; paneId: number }
  | { type: 'continue'; paneId: number }
  | {
      type: 'layoutChange';
      windowId: number;
      layout: string;
      visibleLayout?: string;
      windowFlags?: string;
    }
  | { type: 'sessionChanged'; sessionId: number; name: string }
  | { type: 'windowAdd'; windowId: number }
  | { type: 'windowClose'; windowId: number }
  | { type: 'windowRenamed'; windowId: number; name: string }
  | { type: 'windowPaneChanged'; windowId: number; paneId: number }
  | { type: 'paneModeChanged'; paneId: number }
  | { type: 'clientDetached'; client: string }
  | { type: 'configError'; message: string }
  | { type: 'message'; message: string }
  /** Any other notification, a malformed known one (`malformed: true`), or a stray line. */
  | { type: 'unknown'; name: string; text: string; malformed?: boolean };

const PERCENT = 0x25;
const SPACE = 0x20;
const decoder = new TextDecoder('utf-8');
const GUARD = /^%(begin|end|error) (\d+) (\d+) (\d+)$/;

function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Parses an id like `%3`, `@1` or `$0`; null when malformed. */
function parseId(token: string | undefined, sigil: string): number | null {
  if (!token || token[0] !== sigil || !/^\d+$/.test(token.slice(1))) return null;
  return Number(token.slice(1));
}

/** Index of the n-th space (0-based count) in `line`, or -1. */
function nthSpace(line: Uint8Array, n: number, from = 0): number {
  let index = from - 1;
  for (let i = 0; i <= n; i++) {
    index = line.indexOf(SPACE, index + 1);
    if (index === -1) return -1;
  }
  return index;
}

/**
 * Stateful control-mode line parser (plan §6.4). Feed it the lines of the control client's
 * stdout in order. Inside a `%begin` block every line is data, even one starting with `%`, until
 * a `%end`/`%error` guard carrying the same `time num flags` triple.
 */
export class ControlParser {
  #block: { guard: BlockGuard; lines: Uint8Array[] } | null = null;

  /** True while a `%begin` block is open. */
  get inBlock(): boolean {
    return this.#block !== null;
  }

  /** Returns the event for `line`, or null for a line absorbed into an open block. */
  push(line: Uint8Array): ControlEvent | null {
    const block = this.#block;
    if (block) {
      const guard = line[0] === PERCENT ? this.#guard(line) : null;
      if (guard && guard.kind !== 'begin' && guard.value.raw === block.guard.raw) {
        this.#block = null;
        return {
          type: guard.kind === 'end' ? 'blockEnd' : 'blockError',
          guard: block.guard,
          lines: block.lines,
        };
      }
      block.lines.push(line);
      return null;
    }
    if (line[0] !== PERCENT) return { type: 'unknown', name: '', text: text(line) };
    return this.#notification(line);
  }

  #guard(line: Uint8Array): { kind: string; value: BlockGuard } | null {
    if (line.byteLength > 64) return null;
    const match = GUARD.exec(text(line));
    if (!match) return null;
    const [, kind, time, num, flags] = match;
    return {
      kind: kind!,
      value: {
        time: Number(time),
        num: Number(num),
        flags: Number(flags),
        raw: `${time} ${num} ${flags}`,
      },
    };
  }

  #notification(line: Uint8Array): ControlEvent {
    const nameEnd = line.indexOf(SPACE);
    const name = text(nameEnd === -1 ? line.subarray(1) : line.subarray(1, nameEnd));

    if (name === 'output') {
      const dataStart = nthSpace(line, 1);
      const paneId = parseId(text(line.subarray(nameEnd + 1, dataStart)), '%');
      if (nameEnd === -1 || dataStart === -1 || paneId === null) return this.#malformed(name, line);
      return { type: 'output', paneId, data: unescapeOutput(line.subarray(dataStart + 1)) };
    }
    if (name === 'extended-output') {
      // %extended-output %<pane> <age> [future fields…] : <data>
      const paneEnd = nthSpace(line, 1);
      const ageEnd = paneEnd === -1 ? -1 : line.indexOf(SPACE, paneEnd + 1);
      const paneId = parseId(text(line.subarray(nameEnd + 1, paneEnd)), '%');
      const age = ageEnd === -1 ? '' : text(line.subarray(paneEnd + 1, ageEnd));
      const colon = ageEnd === -1 ? -1 : indexOfSeparator(line, ageEnd);
      if (paneId === null || !/^\d+$/.test(age) || colon === -1) return this.#malformed(name, line);
      return {
        type: 'extendedOutput',
        paneId,
        ageMs: Number(age),
        data: unescapeOutput(line.subarray(colon + 3)),
      };
    }

    const rest = nameEnd === -1 ? '' : text(line.subarray(nameEnd + 1));
    const args = rest === '' ? [] : rest.split(' ');
    switch (name) {
      case 'begin': {
        const guard = this.#guard(line);
        if (!guard) return this.#malformed(name, line);
        this.#block = { guard: guard.value, lines: [] };
        return { type: 'blockBegin', guard: guard.value };
      }
      case 'end':
      case 'error':
        // A guard outside any block: tmux never sends one.
        return this.#malformed(name, line);
      case 'exit':
        return rest === '' ? { type: 'exit' } : { type: 'exit', reason: rest };
      case 'pause':
      case 'continue': {
        const paneId = parseId(args[0], '%');
        if (paneId === null) return this.#malformed(name, line);
        return { type: name, paneId };
      }
      case 'layout-change': {
        const windowId = parseId(args[0], '@');
        if (windowId === null || !args[1]) return this.#malformed(name, line);
        const event: ControlEvent = { type: 'layoutChange', windowId, layout: args[1] };
        if (args[2] !== undefined) event.visibleLayout = args[2];
        if (args[3] !== undefined) event.windowFlags = args.slice(3).join(' ');
        return event;
      }
      case 'session-changed': {
        const sessionId = parseId(args[0], '$');
        if (sessionId === null) return this.#malformed(name, line);
        return { type: 'sessionChanged', sessionId, name: args.slice(1).join(' ') };
      }
      case 'window-add':
      case 'window-close': {
        const windowId = parseId(args[0], '@');
        if (windowId === null) return this.#malformed(name, line);
        return { type: name === 'window-add' ? 'windowAdd' : 'windowClose', windowId };
      }
      case 'window-renamed': {
        const windowId = parseId(args[0], '@');
        if (windowId === null) return this.#malformed(name, line);
        return { type: 'windowRenamed', windowId, name: args.slice(1).join(' ') };
      }
      case 'window-pane-changed': {
        const windowId = parseId(args[0], '@');
        const paneId = parseId(args[1], '%');
        if (windowId === null || paneId === null) return this.#malformed(name, line);
        return { type: 'windowPaneChanged', windowId, paneId };
      }
      case 'pane-mode-changed': {
        const paneId = parseId(args[0], '%');
        if (paneId === null) return this.#malformed(name, line);
        return { type: 'paneModeChanged', paneId };
      }
      case 'client-detached':
        return { type: 'clientDetached', client: rest };
      case 'config-error':
        return { type: 'configError', message: rest };
      case 'message':
        return { type: 'message', message: rest };
      default:
        return { type: 'unknown', name, text: rest };
    }
  }

  #malformed(name: string, line: Uint8Array): ControlEvent {
    return { type: 'unknown', name, text: text(line), malformed: true };
  }
}

/** Index of the first ` : ` at or after `from`, or -1. */
function indexOfSeparator(line: Uint8Array, from: number): number {
  for (let i = line.indexOf(SPACE, from); i !== -1; i = line.indexOf(SPACE, i + 1)) {
    if (line[i + 1] === 0x3a && line[i + 2] === SPACE) return i;
  }
  return -1;
}

/** Pane geometry of a single-pane window layout (`csum,WxH,X,Y,ID`); null for split layouts. */
export function singlePaneLayout(
  layout: string,
): { width: number; height: number; paneId: number } | null {
  const match = /^[0-9a-f]{4},(\d+)x(\d+),\d+,\d+,(\d+)$/.exec(layout);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]), paneId: Number(match[3]) };
}
