import { uuidv7 } from '@termdock/shared';
import { execute, type Sqlite } from './sqlite.ts';

/**
 * Audit event types written by session-manager (plan §10.2; web writes the others): the daemon's
 * own, and `auth.password_reset` / `auth.totp_reset` from the `reset-password` CLI (plan D-36).
 */
export type DaemonAuditType =
  | 'auth.password_reset'
  | 'auth.totp_reset'
  | 'credential.create'
  | 'credential.rename'
  | 'credential.delete'
  | 'host_key.pending'
  | 'host_key.trust'
  | 'host_key.replace'
  | 'host_key.revoke'
  | 'host_key.mismatch'
  | 'host_key.revoked_presented'
  | 'remote_session.terminated'
  | 'remote_session.adopted'
  | 'session.rename'
  | 'session.remove';

export interface AuditInput {
  type: DaemonAuditType;
  actorUserId: string | null;
  targetType: 'credential' | 'server' | 'session' | 'user';
  /** Null only for a host-key event whose server is gone (the decision outlives servers). */
  targetId: string | null;
  /** Public data only (ids, key types, fingerprints, names, labels); never secret material. */
  detail?: Record<string, unknown>;
  at?: number;
}

/** Inserts one audit row; call it inside the transaction of the change it records. */
export function insertAudit(sqlite: Sqlite, input: AuditInput): void {
  const at = input.at ?? Date.now();
  execute(
    sqlite,
    `INSERT INTO audit_events (id, actor_user_id, type, target_type, target_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    uuidv7(at),
    input.actorUserId,
    input.type,
    input.targetType,
    input.targetId,
    input.detail ? JSON.stringify(input.detail) : null,
    at,
  );
}
