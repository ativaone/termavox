/**
 * Failures of the file panel (plan §5.12): the daemon's error codes from `files.result` and
 * transfer responses, plus the few the browser decides on its own. Framework-free and
 * browser-safe: `@termdock/shared` pulls in `node:crypto`, so the codes the panel reads are
 * mirrored here (a T0 test keeps them equal to `ErrorCode`).
 */

/** The daemon's codes the panel tells apart (values of `ErrorCode` in packages/shared). */
export const FileCode = {
  SessionNotConnected: 'SESSION_NOT_CONNECTED',
  SftpUnavailable: 'SFTP_UNAVAILABLE',
  FilesDisabled: 'FILES_DISABLED',
  PermissionDenied: 'PERMISSION_DENIED',
  NameInvalid: 'NAME_INVALID',
  FileOpFailed: 'FILE_OP_FAILED',
  RemoveTooLarge: 'REMOVE_TOO_LARGE',
  Cancelled: 'CANCELLED',
  TransferExpired: 'TRANSFER_EXPIRED',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  RateLimited: 'RATE_LIMITED',
  Forbidden: 'FORBIDDEN',
  Unauthenticated: 'UNAUTHENTICATED',
  BadRequest: 'BAD_REQUEST',
  ConnectionLost: 'CONNECTION_LOST',
  Internal: 'INTERNAL',
} as const;

/** Codes only the browser produces (never sent by the daemon). */
export const ClientFileCode = {
  /** A `files.request` got no answer in time. */
  Timeout: 'TIMEOUT',
  /** A proxy in front of Termdock refused an upload with 413 and a body that is not ours. */
  ProxyTooLarge: 'PROXY_TOO_LARGE',
  /** An upload's HTTP request failed without an answer we can read (network, proxy). */
  TransferFailed: 'TRANSFER_FAILED',
} as const;

/** A file request or transfer that failed, with the code that says why. */
export class FileRequestError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'FileRequestError';
    this.code = code;
  }
}

/** Recognizes a FileRequestError from any copy of this module (name and code, not instanceof). */
export function isFileRequestError(err: unknown): err is FileRequestError {
  return (
    err instanceof FileRequestError ||
    (err instanceof Error &&
      err.name === 'FileRequestError' &&
      typeof (err as { code?: unknown }).code === 'string')
  );
}

/** The code of any failure: a FileRequestError's own, else INTERNAL. */
export function fileErrorCode(err: unknown): string {
  return isFileRequestError(err) ? err.code : FileCode.Internal;
}

/** Message keys under `files.error`. */
export type FileErrorKey =
  | 'sessionNotConnected'
  | 'sftpUnavailable'
  | 'filesDisabled'
  | 'permissionDenied'
  | 'nameInvalid'
  | 'fileOpFailed'
  | 'removeTooLarge'
  | 'cancelled'
  | 'transferExpired'
  | 'notFound'
  | 'conflict'
  | 'rateLimited'
  | 'forbidden'
  | 'badRequest'
  | 'connectionLost'
  | 'timeout'
  | 'proxyTooLarge'
  | 'transferFailed'
  | 'generic';

const KEYS: Readonly<Record<string, FileErrorKey>> = {
  [FileCode.SessionNotConnected]: 'sessionNotConnected',
  [FileCode.SftpUnavailable]: 'sftpUnavailable',
  [FileCode.FilesDisabled]: 'filesDisabled',
  [FileCode.PermissionDenied]: 'permissionDenied',
  [FileCode.NameInvalid]: 'nameInvalid',
  [FileCode.FileOpFailed]: 'fileOpFailed',
  [FileCode.RemoveTooLarge]: 'removeTooLarge',
  [FileCode.Cancelled]: 'cancelled',
  [FileCode.TransferExpired]: 'transferExpired',
  [FileCode.NotFound]: 'notFound',
  [FileCode.Conflict]: 'conflict',
  [FileCode.RateLimited]: 'rateLimited',
  [FileCode.Forbidden]: 'forbidden',
  [FileCode.Unauthenticated]: 'forbidden',
  [FileCode.BadRequest]: 'badRequest',
  [FileCode.ConnectionLost]: 'connectionLost',
  [ClientFileCode.Timeout]: 'timeout',
  [ClientFileCode.ProxyTooLarge]: 'proxyTooLarge',
  [ClientFileCode.TransferFailed]: 'transferFailed',
};

/** The message key for a code; unknown codes (INTERNAL included) read as the generic message. */
export function fileErrorKey(code: string): FileErrorKey {
  return Object.hasOwn(KEYS, code) ? KEYS[code]! : 'generic';
}
