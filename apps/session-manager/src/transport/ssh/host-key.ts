import { createHash } from 'node:crypto';
import type { ServerHostKeyAlgorithm } from 'ssh2';

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

/**
 * ssh2's default server host key algorithms (lib/protocol/constants.js DEFAULT_SERVER_HOST_KEY
 * on a Node with Ed25519), most preferred first. A T0 test keeps the two in sync.
 */
export const DEFAULT_HOST_KEY_ALGORITHMS: readonly ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
];

/** Signature algorithms that authenticate a host key of `keyType` (RSA keys have three). */
function algorithmsForKeyType(keyType: string): string[] {
  return keyType === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [keyType];
}

/**
 * The `serverHostKey` list for a host with trusted keys of `trustedTypes`: those algorithms
 * first, then the other defaults. A server with several host keys then presents the trusted one
 * instead of whichever type ssh2 prefers, which would read as a mismatch. Undefined (keep ssh2's
 * default) when nothing is trusted yet.
 */
export function hostKeyAlgorithms(
  trustedTypes: Iterable<string>,
): ServerHostKeyAlgorithm[] | undefined {
  const preferred = [...trustedTypes]
    .flatMap(algorithmsForKeyType)
    .filter((a): a is ServerHostKeyAlgorithm =>
      (DEFAULT_HOST_KEY_ALGORITHMS as readonly string[]).includes(a),
    );
  if (preferred.length === 0) return undefined;
  return [...new Set([...preferred, ...DEFAULT_HOST_KEY_ALGORITHMS])];
}

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
