const BACKSLASH = 0x5c;

function isOctal(byte: number | undefined): byte is number {
  return byte !== undefined && byte >= 0x30 && byte <= 0x37;
}

/**
 * Decodes a `%output` payload (plan §6.4): tmux writes bytes < 0x20 and `\` as `\ooo` (exactly
 * three octal digits) and every other byte raw. A backslash not followed by three octal digits
 * is kept literally (tmux never produces one).
 */
export function unescapeOutput(data: Uint8Array): Uint8Array {
  let index = data.indexOf(BACKSLASH);
  if (index === -1) return data.slice();
  const out = new Uint8Array(data.byteLength);
  out.set(data.subarray(0, index));
  let length = index;
  while (index < data.byteLength) {
    const byte = data[index]!;
    const a = data[index + 1];
    const b = data[index + 2];
    const c = data[index + 3];
    if (byte === BACKSLASH && isOctal(a) && isOctal(b) && isOctal(c)) {
      out[length++] = (((a - 0x30) << 6) | ((b - 0x30) << 3) | (c - 0x30)) & 0xff;
      index += 4;
    } else {
      out[length++] = byte;
      index++;
    }
  }
  return out.slice(0, length);
}
