/** Canonical error codes shared by web, session-manager and the WS/internal protocols. */
export const ErrorCode = {
  BadRequest: 'BAD_REQUEST',
  Unauthenticated: 'UNAUTHENTICATED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  RateLimited: 'RATE_LIMITED',
  ProtocolUnsupported: 'PROTOCOL_UNSUPPORTED',
  HostUnreachable: 'HOST_UNREACHABLE',
  ConnectionLost: 'CONNECTION_LOST',
  ChannelFailed: 'CHANNEL_FAILED',
  HostKeyMismatch: 'HOST_KEY_MISMATCH',
  HostKeyRejected: 'HOST_KEY_REJECTED',
  AuthRejected: 'AUTH_REJECTED',
  AuthTimeout: 'AUTH_TIMEOUT',
  CredentialInvalid: 'CREDENTIAL_INVALID',
  LocalShellDisabled: 'LOCAL_SHELL_DISABLED',
  SessionEnded: 'SESSION_ENDED',
  Internal: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class TermdockError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TermdockError';
    this.code = code;
    this.details = details;
  }
}
