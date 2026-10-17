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
  /**
   * The server has no stored credential, and the daemon needs to sign in without a person
   * answering a prompt (remote leftovers, plan D-30): nothing is contacted.
   */
  CredentialRequired: 'CREDENTIAL_REQUIRED',
  LocalShellDisabled: 'LOCAL_SHELL_DISABLED',
  /** A launch parameter (server or probe value) cannot be passed to the remote safely. */
  BadLaunchParams: 'BAD_LAUNCH_PARAMS',
  /** The SSH target resolves only to addresses the daemon's target policy denies. */
  TargetNotAllowed: 'TARGET_NOT_ALLOWED',
  SessionEnded: 'SESSION_ENDED',
  /** A session label is empty or longer than 120 characters once cleaned and trimmed. */
  LabelInvalid: 'LABEL_INVALID',
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

/**
 * Recognizes a TermdockError from any copy of this module. Next bundles a server module once per
 * layer, so an error thrown by the web's auth runtime (built at boot by instrumentation and kept
 * on globalThis) is an instance of another TermdockError class than the one a Server Action
 * imports, and `instanceof` alone misses it.
 */
export function isTermdockError(err: unknown): err is TermdockError {
  return (
    err instanceof TermdockError ||
    (err instanceof Error &&
      err.name === 'TermdockError' &&
      typeof (err as { code?: unknown }).code === 'string')
  );
}
