import { uuidv7 } from '@termdock/shared';
import { execute, type Sqlite } from './sqlite.ts';

/** Audit event types written by the daemon (plan §10.2; web writes the others). */
export type DaemonAuditType =
  | 'credential.create'
  | 'credential.rename'
  | 'credential.delete'
  | 'host_key.pending'
  | 'host_key.trust'
  | 'host_key.replace'
  | 'host_key.revoke'
  | 'host_key.mismatch';

export interface AuditInput {
  type: DaemonAuditType;
  actorUserId: string | null;
  targetType: 'credential' | 'host';
  targetId: string;
  /** Public data only (ids, key types, fingerprints, names); never secret material. */
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
