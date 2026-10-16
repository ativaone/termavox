import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';

/**
 * Reads of the user's credentials (public columns only: never ciphertext or nonce). The daemon
 * owns every write (plan §9); web creates, renames and deletes through the internal API.
 */

export interface CredentialSummary {
  id: string;
  name: string;
  kind: 'password' | 'private_key';
  /** OpenSSH public key line, for key credentials. */
  publicKey: string | null;
  fingerprint: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  profileCount: number;
}

export function listCredentials(db: TermdockDb, userId: string): CredentialSummary[] {
  const rows = db.$client
    .prepare(
      `SELECT c.id, c.name, c.kind, c.public_key, c.fingerprint_sha256, c.created_at, c.last_used_at,
              (SELECT COUNT(*) FROM connection_profiles p
                WHERE p.credential_id = c.id AND p.user_id = c.user_id) AS profile_count
         FROM credentials c
        WHERE c.user_id = ?
        ORDER BY c.name COLLATE NOCASE, c.id`,
    )
    .all(userId) as Array<{
    id: string;
    name: string;
    kind: string;
    public_key: string | null;
    fingerprint_sha256: string | null;
    created_at: number;
    last_used_at: number | null;
    profile_count: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind === 'password' ? 'password' : 'private_key',
    publicKey: r.public_key,
    fingerprint: r.fingerprint_sha256,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    profileCount: r.profile_count,
  }));
}

export function getCredentialName(
  db: TermdockDb,
  userId: string,
  credentialId: string,
): string | null {
  const row = db.$client
    .prepare('SELECT name FROM credentials WHERE id = ? AND user_id = ?')
    .get(credentialId, userId) as { name: string } | undefined;
  return row?.name ?? null;
}
