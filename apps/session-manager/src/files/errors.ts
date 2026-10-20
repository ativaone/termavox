import { ErrorCode, isTermavoxError, TermavoxError } from '@termavox/shared';
import type { Logger } from '../config/logger.ts';
import { hostText } from '../core/host-text.ts';
import { SftpError, SftpStatus, TransportError } from '../core/types.ts';

/** Server text quoted in a FILE_OP_FAILED message. */
export const SERVER_MESSAGE_MAX = 200;

/**
 * The error a file request answers with (plan §5.12). SFTP statuses map to NOT_FOUND,
 * PERMISSION_DENIED and FILE_OP_FAILED (the server's message, cleaned and capped); a channel or
 * connection that went away is SESSION_NOT_CONNECTED. TermavoxErrors pass through. Anything else
 * is a bug on our side: logged, and answered as INTERNAL without its text.
 */
export function fileError(err: unknown, log?: Logger): TermavoxError {
  if (isTermavoxError(err)) return err;
  if (err instanceof SftpError) return fromStatus(err);
  if (err instanceof TransportError) return notConnected();
  log?.error({ err }, 'file request failed');
  return new TermavoxError(ErrorCode.Internal, 'internal error');
}

export function notConnected(): TermavoxError {
  return new TermavoxError(ErrorCode.SessionNotConnected, 'the session is not connected');
}

/** The SFTP status of an error, or null when it is not an SFTP error. */
export function sftpStatus(err: unknown): number | null {
  return err instanceof SftpError ? err.status : null;
}

function fromStatus(err: SftpError): TermavoxError {
  switch (err.status) {
    case SftpStatus.NoSuchFile:
      return new TermavoxError(ErrorCode.NotFound, 'no such file or folder');
    case SftpStatus.PermissionDenied:
      return new TermavoxError(ErrorCode.PermissionDenied, 'permission denied');
    case SftpStatus.NoConnection:
    case SftpStatus.ConnectionLost:
      return notConnected();
    default: {
      // FAILURE, OP_UNSUPPORTED, BAD_MESSAGE and any status the server should not have sent.
      const text = hostText(err.message, SERVER_MESSAGE_MAX).trim();
      return new TermavoxError(ErrorCode.FileOpFailed, text || 'the server could not do it');
    }
  }
}
