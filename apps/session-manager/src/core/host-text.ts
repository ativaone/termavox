import { isControlChar, isInvisibleFormatChar } from '@termavox/protocol';

/**
 * Text a remote host decides (tmux replies, SFTP server messages) made safe before it reaches an
 * error message, the logs or the browser. Shared by the transports, the drivers and the file panel.
 */

/**
 * Host text that reaches an error message, and so the logs and the `desync` session event, is at
 * most this many UTF-16 units, prefix included (see hostMessage).
 */
export const HOST_TEXT_MAX = 300;
/** Reply bytes decoded at most: more than HOST_TEXT_MAX characters can take (4 bytes each). */
const DECODE_MAX_BYTES = 4 * HOST_TEXT_MAX;
const decoder = new TextDecoder();

/**
 * Text the host sent (tmux reply lines, a `%exit` reason, stderr, an SFTP status message) made
 * safe for an error message: lines joined with spaces, C0/C1 controls and invisible formatting (bidi
 * overrides, zero-width characters) dropped, cut to `max` UTF-16 units without splitting a
 * character. Untrusted (§10.2): a hostile or broken host decides what it says and how much.
 */
export function hostText(host: string | readonly Uint8Array[], max = HOST_TEXT_MAX): string {
  let out = '';
  for (const ch of typeof host === 'string' ? host : decodeLines(host)) {
    const code = ch.codePointAt(0)!;
    if (isControlChar(code) || isInvisibleFormatChar(code)) continue;
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** `prefix` (our own words) followed by host text, at most HOST_TEXT_MAX units in all. */
export function hostMessage(
  prefix: string,
  host: string | readonly Uint8Array[],
  suffix = '',
): string {
  return `${prefix}${hostText(host, Math.max(0, HOST_TEXT_MAX - prefix.length - suffix.length))}${suffix}`;
}

/** The start of the reply, lines joined with spaces: a reply may be megabytes long. */
function decodeLines(lines: readonly Uint8Array[]): string {
  let text = '';
  let budget = DECODE_MAX_BYTES;
  for (const line of lines) {
    if (budget <= 0) break;
    if (text !== '') text += ' ';
    const part = line.subarray(0, budget);
    budget -= part.byteLength + 1;
    text += decoder.decode(part);
  }
  return text;
}
