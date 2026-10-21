import { concatBytes } from './lines.ts';

/** Input bytes per `send-keys` command (plan §6.5: ≤ 1 KiB per command). */
export const MAX_INPUT_BYTES_PER_COMMAND = 1024;

/**
 * Keys sent to tmux by name: the browser's xterm encodes Home and End as `CSI H` / `CSI F`
 * (`SS3 H` / `SS3 F` in application cursor mode), but a pane's terminal (`tmux-256color` or
 * `screen-256color`) reads `CSI 1 ~` / `CSI 4 ~`, so vim took `SS3 F` for Escape, `O`, `F`. A
 * tmux client translates them; in control mode nothing does, so they go by name and tmux encodes
 * them for the pane. Every other key the browser sends reads the same in both terminals.
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
 * Encodes queued input in order: runs of bytes as `send-keys -H` commands (encodeInput), keys
 * as `send-keys -t %<pane> <name>`.
 */
export function encodeInputItems(paneId: number, items: readonly InputItem[]): string[] {
  const commands: string[] = [];
  let run: Uint8Array[] = [];
  const flushRun = () => {
    if (run.length > 0) commands.push(...encodeInput(paneId, concatBytes(run)));
    run = [];
  };
  for (const item of items) {
    if (typeof item === 'string') {
      flushRun();
      commands.push(`send-keys -t %${paneId} ${item}`);
    } else {
      run.push(item);
    }
  }
  flushRun();
  return commands;
}
