import '../server-guard.ts';
import type { TermavoxDb } from '@termavox/db';

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
  /** How many of the user's servers sign in with it. */
  serverCount: number;
}

export function listCredentials(db: TermavoxDb, userId: string): CredentialSummary[] {
  const rows = db.$client
    .prepare(
      `SELECT c.id, c.name, c.kind, c.public_key, c.fingerprint_sha256, c.created_at, c.last_used_at,
              (SELECT COUNT(*) FROM servers s
                WHERE s.credential_id = c.id AND s.user_id = c.user_id) AS server_count
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
    server_count: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind === 'password' ? 'password' : 'private_key',
    publicKey: r.public_key,
    fingerprint: r.fingerprint_sha256,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    serverCount: r.server_count,
  }));
}

export function getCredentialName(
  db: TermavoxDb,
  userId: string,
  credentialId: string,
): string | null {
  const row = db.$client
    .prepare('SELECT name FROM credentials WHERE id = ? AND user_id = ?')
    .get(credentialId, userId) as { name: string } | undefined;
  return row?.name ?? null;
}
