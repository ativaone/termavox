/**
 * Why a session stopped, as message keys under `workspace.failure.*` and `workspace.endReason.*`.
 * Shared by the in-pane slips and the activity log so a code reads the same everywhere.
 */

/** Known failure details (`session.status` detail of `failed`), mapped to their message key. */
export const FAILURE_KEYS = {
  AUTH_REJECTED: 'authRejected',
  CREDENTIAL_INVALID: 'credentialInvalid',
  HOST_KEY_REJECTED: 'hostKeyRejected',
  HOST_KEY_MISMATCH: 'hostKeyMismatch',
  HOST_UNREACHABLE: 'hostUnreachable',
  // The only NOT_FOUND a session parks with: its server was deleted (plan D-29).
  NOT_FOUND: 'serverDeleted',
  FORBIDDEN: 'forbidden',
  LOCAL_SHELL_DISABLED: 'localShellDisabled',
  BAD_LAUNCH_PARAMS: 'badLaunchParams',
  TARGET_NOT_ALLOWED: 'targetNotAllowed',
} as const;

/** End reasons (`sessions.end_reason`, the detail of `ended`), mapped to their message key. */
export const END_KEYS = {
  user_terminated: 'userTerminated',
  shell_exited: 'shellExited',
  connection_lost: 'connectionLost',
  service_restarted: 'serviceRestarted',
  error: 'error',
} as const;

/** The message key for `key` in `table`, or null when the code is unknown. */
export function pick<T extends Record<string, string>>(
  table: T,
  key: string | null | undefined,
): T[keyof T] | null {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key as keyof T] : null;
}
