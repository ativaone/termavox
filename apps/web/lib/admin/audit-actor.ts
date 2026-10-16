import type { AuditRow } from '../repo/audit.ts';

/**
 * Failed sign-ins (and the lockouts they cause) carry no actor: whoever tried is not a known,
 * signed-in user. Every other row without an actor was written by the system itself (e.g. the
 * daemon's host-key events).
 */
const ANONYMOUS_AUTH_FAILURES: ReadonlySet<string> = new Set([
  'auth.login_failure',
  'auth.lockout',
]);

/** The audit viewer's Actor cell: name, else a short id, else "Unknown user" or "System". */
export function auditActorLabel(
  row: Pick<AuditRow, 'type' | 'actorId' | 'actorName'>,
  t: (key: 'system' | 'unknownUser') => string,
): string {
  if (row.actorName !== null) return row.actorName;
  if (row.actorId !== null) return row.actorId.slice(0, 8);
  return t(ANONYMOUS_AUTH_FAILURES.has(row.type) ? 'unknownUser' : 'system');
}
