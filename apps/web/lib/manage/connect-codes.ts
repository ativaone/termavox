/**
 * Why a connection the server page asked for failed (Test connection, Check now): the daemon's
 * error codes that have their own wording under `servers.diagnostics.code.*`. Anything else
 * reads as `OTHER`. Browser-safe: the diagnostics card maps codes on the client.
 */
export const CONNECT_CODES = [
  'HOST_UNREACHABLE',
  'TARGET_NOT_ALLOWED',
  'HOST_KEY_MISMATCH',
  'AUTH_REJECTED',
  'AUTH_TIMEOUT',
  'CREDENTIAL_INVALID',
  'PROBE_TIMEOUT',
  'PROBE_TOO_LARGE',
  'CONNECTION_LOST',
] as const;
export type ConnectCode = (typeof CONNECT_CODES)[number];

export function connectCodeKey(code: string | null | undefined): ConnectCode | 'OTHER' {
  return code && (CONNECT_CODES as readonly string[]).includes(code)
    ? (code as ConnectCode)
    : 'OTHER';
}
