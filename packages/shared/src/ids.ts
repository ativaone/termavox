import { randomBytes } from 'node:crypto';

const MAX_TIMESTAMP = 2 ** 48 - 1;
const MAX_COUNTER = 0xfff;

/**
 * A UUIDv7 generator with its own monotonic state (RFC 9562 §5.7, §6.2 method 1): 48-bit unix-ms
 * timestamp, version 7, a 12-bit counter in `rand_a`, variant 10, 62 random bits in `rand_b`.
 *
 * - A new millisecond re-seeds the counter at random with its top bit clear (at least 2048
 *   increments of headroom); each further id in the same millisecond increments it, so ids from
 *   one generator sort in the order they were made.
 * - A timestamp older than the last one (callers pass explicit times) keeps the last timestamp
 *   and increments the counter: order wins over the embedded time.
 * - A full counter borrows the next millisecond and re-seeds.
 *
 * The embedded timestamp is therefore never earlier than `now`, and later after an earlier
 * caller time or a full millisecond: read times from the stored timestamp columns, not from ids.
 */
export function createUuidv7(
  random: (size: number) => Buffer = randomBytes,
): (now?: number) => string {
  let lastMs = -1;
  let counter = 0;
  return (now = Date.now()) => {
    const ms = Math.trunc(now);
    if (!(ms >= 0 && ms <= MAX_TIMESTAMP)) {
      throw new RangeError(`uuidv7: timestamp out of range: ${now}`);
    }
    const bytes = random(16);
    if (ms > lastMs) {
      lastMs = ms;
      counter = ((bytes[6]! & 0x07) << 8) | bytes[7]!;
    } else if (counter < MAX_COUNTER) {
      counter += 1;
    } else {
      lastMs += 1;
      counter = ((bytes[6]! & 0x07) << 8) | bytes[7]!;
    }
    bytes[0] = (lastMs / 2 ** 40) & 0xff;
    bytes[1] = (lastMs / 2 ** 32) & 0xff;
    bytes[2] = (lastMs / 2 ** 24) & 0xff;
    bytes[3] = (lastMs / 2 ** 16) & 0xff;
    bytes[4] = (lastMs / 2 ** 8) & 0xff;
    bytes[5] = lastMs & 0xff;
    bytes[6] = 0x70 | (counter >> 8);
    bytes[7] = counter & 0xff;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/**
 * RFC 9562 UUIDv7, monotonic within this process: events written in the same millisecond keep
 * their order when sorted by id (see `createUuidv7`).
 */
export const uuidv7: (now?: number) => string = createUuidv7();

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase base32 token, safe for tmux socket and session names ([a-z2-7]). */
export function randomToken(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += BASE32[bytes[i]! & 31];
  return out;
}
