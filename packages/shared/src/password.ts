import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * argon2id password hashing, built on Node's `crypto.argon2` (Node >= 24.7): web's Better Auth
 * (`emailAndPassword.password`) and session-manager's `reset-password` CLI both use it. Hashes are PHC strings, so each one carries the parameters it
 * was made with and a later parameter change keeps verifying old hashes.
 */
export interface Argon2Params {
  /** Memory cost in KiB. */
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

/** OWASP's minimum argon2id configuration (19 MiB, t=2, p=1): about 0.1–0.2 s per hash. */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = { memoryKiB: 19_456, passes: 2, parallelism: 1 };

const SALT_BYTES = 16;
const TAG_BYTES = 32;
// Upper bounds for parameters read back from a stored hash, so a corrupt row cannot pin the CPU.
const MAX_MEMORY_KIB = 262_144;
const MAX_PASSES = 16;
const MAX_PARALLELISM = 16;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const argon2Async = promisify(argon2);

function derive(password: string, salt: Uint8Array, params: Argon2Params, tagLength: number) {
  return argon2Async('argon2id', {
    message: password,
    nonce: salt,
    memory: params.memoryKiB,
    passes: params.passes,
    parallelism: params.parallelism,
    tagLength,
  });
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');

export async function hashPassword(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, params, TAG_BYTES);
  const { memoryKiB: m, passes: t, parallelism: p } = params;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(tag)}`;
}

/** Constant-time check; any malformed or out-of-bounds hash is a mismatch, never an exception. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const match = PHC.exec(hash);
  if (!match) return false;
  const params: Argon2Params = {
    memoryKiB: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
  };
  if (
    params.memoryKiB > MAX_MEMORY_KIB ||
    params.passes < 1 ||
    params.passes > MAX_PASSES ||
    params.parallelism < 1 ||
    params.parallelism > MAX_PARALLELISM
  ) {
    return false;
  }
  const salt = Buffer.from(match[4]!, 'base64');
  const expected = Buffer.from(match[5]!, 'base64');
  if (salt.length < 8 || expected.length < 16) return false;
  try {
    const actual = await derive(password, salt, params, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
