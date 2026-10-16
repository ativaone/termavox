import { createSecretKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const MASTER_KEY_BYTES = 32;

/** Vault configuration/boot failure. Messages never contain key material. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

/**
 * Loads the vault KEK from `TERMDOCK_MASTER_KEY_FILE` (plan §10.2, §13.2): the trimmed file
 * content is standard base64 of exactly 32 random bytes (`openssl rand -base64 32`). The key is
 * moved into a `KeyObject` (native memory) and the decoded buffer is zeroed. The file's text
 * itself is a JS string and cannot be wiped.
 */
export async function loadMasterKey(path: string): Promise<KeyObject> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new VaultError(`cannot read TERMDOCK_MASTER_KEY_FILE ${path} (${code})`);
  }
  return parseMasterKey(text, path);
}

export function parseMasterKey(text: string, source = 'master key'): KeyObject {
  const encoded = text.trim();
  const hint = 'expected 32 random bytes, base64-encoded (e.g. `openssl rand -base64 32`)';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    throw new VaultError(`${source} is not valid base64: ${hint}`);
  }
  const raw = Buffer.from(encoded, 'base64');
  try {
    if (raw.length !== MASTER_KEY_BYTES) {
      throw new VaultError(`${source} decodes to ${raw.length} bytes: ${hint}`);
    }
    return createSecretKey(raw);
  } finally {
    raw.fill(0);
  }
}
