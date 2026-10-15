import { randomBytes } from 'node:crypto';

/** RFC 9562 UUIDv7: 48-bit unix-ms timestamp, version 7, variant 10, 74 random bits. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase base32 token, safe for tmux socket and session names ([a-z2-7]). */
export function randomToken(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += BASE32[bytes[i]! & 31];
  return out;
}
