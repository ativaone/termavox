import { createHash } from 'node:crypto';

/** A host key as presented during the SSH handshake (plan §5.9). */
export interface HostKeyInfo {
  /** Key type parsed from the key blob, e.g. `ssh-ed25519`, `ecdsa-sha2-nistp256`. */
  type: string;
  /** OpenSSH format: `SHA256:<unpadded base64>` (43 base64 characters). */
  fingerprint: string;
  /** The raw key blob, base64 (the second field of an OpenSSH `.pub` line). */
  publicKeyB64: string;
}

export type HostKeyDecision = 'trusted' | 'unknown' | 'mismatch';

/** OpenSSH-style SHA256 fingerprint of a public key blob. */
export function fingerprintOf(blob: Uint8Array): string {
  const digest = createHash('sha256').update(blob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** Parses an SSH wire-format public key blob (`string type` + key material). */
export function describeHostKey(blob: Uint8Array): HostKeyInfo {
  if (blob.byteLength < 4) throw new RangeError('host key blob too short');
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const typeLength = view.getUint32(0);
  if (typeLength === 0 || typeLength > 64 || 4 + typeLength > blob.byteLength) {
    throw new RangeError('malformed host key blob');
  }
  const type = new TextDecoder('ascii').decode(blob.subarray(4, 4 + typeLength));
  if (!/^[\x21-\x7e]+$/.test(type)) throw new RangeError('malformed host key type');
  return {
    type,
    fingerprint: fingerprintOf(blob),
    publicKeyB64: Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).toString('base64'),
  };
}

/**
 * Normalizes a pasted fingerprint to `SHA256:<unpadded base64>` (plan §5.9): trims, adds the
 * prefix if missing and strips `=` padding. Returns null when it is not a SHA256 fingerprint.
 */
export function normalizeFingerprint(input: string): string | null {
  let value = input.trim();
  if (/^sha256:/i.test(value)) value = value.slice(7);
  value = value.replace(/=+$/, '');
  return /^[A-Za-z0-9+/]{43}$/.test(value) ? `SHA256:${value}` : null;
}

/** Parses one OpenSSH public key line (`<type> <base64> [comment]`). */
export function parsePublicKeyLine(line: string): HostKeyInfo {
  const [, b64] = line.trim().split(/\s+/);
  if (!b64) throw new RangeError('malformed public key line');
  return describeHostKey(Buffer.from(b64, 'base64'));
}
