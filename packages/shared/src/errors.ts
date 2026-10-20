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
  /** The user stopped a session's connection retries (plan D-31): it waits for Retry or End. */
  RetriesStopped: 'RETRIES_STOPPED',
  /** A session label is empty or longer than 120 characters once cleaned and trimmed. */
  LabelInvalid: 'LABEL_INVALID',
  /** File panel (plan §5.12): the session is not connected, so it has no SFTP channel. */
  SessionNotConnected: 'SESSION_NOT_CONNECTED',
  /** The server refused the SFTP subsystem (sshd without `Subsystem sftp`). */
  SftpUnavailable: 'SFTP_UNAVAILABLE',
  /** An administrator turned file transfer off (instance setting `file_transfer_enabled`). */
  FilesDisabled: 'FILES_DISABLED',
  /** The server refused a file operation for lack of permission (SFTP PERMISSION_DENIED). */
  PermissionDenied: 'PERMISSION_DENIED',
  /** A file or folder name is empty, `.`/`..`, holds `/` or NUL, or exceeds 255 UTF-8 bytes. */
  NameInvalid: 'NAME_INVALID',
  /** The server failed a file operation without a more precise status (SFTP FAILURE). */
  FileOpFailed: 'FILE_OP_FAILED',
  /**
   * The file panel's Delete stopped at Termdock's own bound (plan §5.12): a folder nested too
   * deep, or more entries or bytes of names read than one request may hold. What it removed by
   * then stays removed; the rest is for the terminal (`rm -r`).
   */
  RemoveTooLarge: 'REMOVE_TOO_LARGE',
  /** The user cancelled a file request or a transfer. */
  Cancelled: 'CANCELLED',
  /** A transfer URL expired unused: the browser never started that download (or upload). */
  TransferExpired: 'TRANSFER_EXPIRED',
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
