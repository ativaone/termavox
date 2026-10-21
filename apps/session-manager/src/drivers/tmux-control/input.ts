import type { DefaultTerminal } from './commands.ts';
import { concatBytes } from './lines.ts';

/** Input bytes per `send-keys` command (plan §6.5: ≤ 1 KiB per command). */
export const MAX_INPUT_BYTES_PER_COMMAND = 1024;
/** Keys by name per `send-keys` command: a held Home key costs a few commands, not hundreds. */
export const MAX_KEYS_PER_COMMAND = 64;

/**
 * Keys sent to tmux by name: the browser's xterm encodes Home and End as `CSI H` / `CSI F`
 * (`SS3 H` / `SS3 F` in application cursor mode), but a pane whose terminal is tmux's own
 * (`tmux-256color` or `screen-256color`) reads `CSI 1 ~` / `CSI 4 ~`, so vim took `SS3 F` for
 * Escape, `O`, `F`. A tmux client translates them; in control mode nothing does, so they go by
 * name and tmux encodes them for the pane. Every other key the browser sends reads the same in
 * both terminals. A pane of type `xterm-256color` (plan D-49) reads the browser's bytes as they
 * are, so it gets them unchanged (see homeEndByName).
 */
export type TmuxKey = 'Home' | 'End';

/** Input as it reaches the driver: bytes, or a key that goes to tmux by name. */
export type InputItem = Uint8Array | TmuxKey;

const ESC = 0x1b;
const CSI_OR_SS3 = new Set([0x5b, 0x4f]); // '[' and 'O'
const FINALS: Readonly<Record<number, TmuxKey>> = { 72: 'Home', 70: 'End' }; // 'H', 'F'

/**
 * The key a browser input event stands for, when it is exactly Home or End. Only a whole event
 * counts (a key arrives as one event with one sequence), so Alt+O followed by F stays two keys.
 */
export function tmuxKeyOf(data: Uint8Array): TmuxKey | null {
  if (data.byteLength !== 3 || data[0] !== ESC || !CSI_OR_SS3.has(data[1]!)) return null;
  return FINALS[data[2]!] ?? null;
}

/**
 * Whether Home and End go to tmux by name for a pane of this terminal type (plan §6.5, D-49):
 * yes for tmux's own types; `xterm-256color` reads the browser's bytes exactly as xterm sends them.
 */
export function homeEndByName(terminal: DefaultTerminal): boolean {
  return terminal !== 'xterm-256color';
}

/** One browser input event as the driver queues it: Home or End by name when `byName`, else bytes. */
export function inputItemOf(data: Uint8Array, byName: boolean): InputItem {
  return (byName ? tmuxKeyOf(data) : null) ?? data.slice();
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * Encodes input bytes as `send-keys -H -t %<pane> <hex> …` commands, one byte per argument.
 * Safe for C0, ESC, DEL, UTF-8 and bracketed-paste markers, and bypasses `escape-time`.
 */
export function encodeInput(
  paneId: number,
  data: Uint8Array,
  maxBytesPerCommand = MAX_INPUT_BYTES_PER_COMMAND,
): string[] {
  if (!Number.isInteger(paneId) || paneId < 0) throw new RangeError(`invalid pane id: ${paneId}`);
  if (!Number.isInteger(maxBytesPerCommand) || maxBytesPerCommand < 1) {
    throw new RangeError(`invalid chunk size: ${maxBytesPerCommand}`);
  }
  const commands: string[] = [];
  for (let start = 0; start < data.byteLength; start += maxBytesPerCommand) {
    const end = Math.min(start + maxBytesPerCommand, data.byteLength);
    const hex = new Array<string>(end - start);
    for (let i = start; i < end; i++) hex[i - start] = HEX[data[i]!]!;
    commands.push(`send-keys -H -t %${paneId} ${hex.join(' ')}`);
  }
  return commands;
}

/**
 * Encodes queued input in order: runs of bytes as `send-keys -H` commands (encodeInput), runs of
 * keys as `send-keys -t %<pane> <name> <name> …`, at most MAX_KEYS_PER_COMMAND keys per command.
 */
export function encodeInputItems(
  paneId: number,
  items: readonly InputItem[],
  maxKeysPerCommand = MAX_KEYS_PER_COMMAND,
): string[] {
  if (!Number.isInteger(paneId) || paneId < 0) throw new RangeError(`invalid pane id: ${paneId}`);
  if (!Number.isInteger(maxKeysPerCommand) || maxKeysPerCommand < 1) {
    throw new RangeError(`invalid key count: ${maxKeysPerCommand}`);
  }
  const commands: string[] = [];
  let run: Uint8Array[] = [];
  let keys: TmuxKey[] = [];
  const flushRun = () => {
    if (run.length > 0) commands.push(...encodeInput(paneId, concatBytes(run)));
    run = [];
  };
  const flushKeys = () => {
    if (keys.length > 0) commands.push(`send-keys -t %${paneId} ${keys.join(' ')}`);
    keys = [];
  };
  for (const item of items) {
    if (typeof item === 'string') {
      flushRun();
      keys.push(item);
      if (keys.length === maxKeysPerCommand) flushKeys();
    } else {
      flushKeys();
      run.push(item);
    }
  }
  flushKeys();
  flushRun();
  return commands;
}
