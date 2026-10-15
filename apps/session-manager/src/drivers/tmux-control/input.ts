/** Input bytes per `send-keys` command (plan §6.5: ≤ 1 KiB per command). */
export const MAX_INPUT_BYTES_PER_COMMAND = 1024;

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
