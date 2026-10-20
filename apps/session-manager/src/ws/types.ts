import type { FileRequest, FileResult, ServerMessage, SessionSummary } from '@termavox/protocol';
import type { AttachmentClient, FileHost, SessionHost } from '../core/types.ts';
import type { TransferBackend } from '../files/transfer-routes.ts';

/**
 * Validates the auth session behind a WebSocket (plan §7.1): it exists, has not expired and its
 * user is not banned. Implemented over the Better Auth tables by the persistence workstream.
 */
export interface AuthSessionValidator {
  isValid(authSessionId: string, userId: string): boolean | Promise<boolean>;
}

/** What the WebSocket server needs from the session registry. */
export interface SessionGateway {
  /** A session runtime that is live in this process. */
  host(sessionId: string): SessionHost | undefined;
  /** The file panel's view of a live session runtime (plan §5.12); undefined when none is live. */
  fileHost(sessionId: string): FileHost | undefined;
  /** Loads the runtime of an existing session for attaching; null when it does not exist. */
  attachable(sessionId: string): Promise<SessionHost | null>;
  listForUser(userId: string): Promise<SessionSummary[]>;
  /** Prompts and retry progress waiting for this user, replayed after `sessions.list`. */
  pendingPrompts(userId: string): ServerMessage[];
  hostKeyDecision(
    sessionId: string,
    fingerprint: string,
    accept: boolean,
    userId: string,
  ): Promise<boolean>;
  authResponse(sessionId: string, promptId: string, answers: string[], userId: string): boolean;
}

/** One `files.request` of a WebSocket connection, its ownership already checked (plan §5.12). */
export interface FileRequestContext {
  requestId: string;
  userId: string;
  /** The connection's auth session: a transfer URL is bound to it (and revoked with it). */
  authSessionId: string;
  sessionId: string;
  /** The connection's client: address and user agent for the audit rows. */
  client: AttachmentClient;
  /** Aborted by `files.cancel` and when the connection closes. */
  signal: AbortSignal;
  /** Sends to the connection that made the request (`files.progress`, transfer progress). */
  send(message: ServerMessage): void;
}

/** What the WebSocket server needs from the file service. */
export interface FileGateway {
  /** Runs one request; rejects with a TermavoxError (its code and message go to the browser). */
  handle(context: FileRequestContext, request: FileRequest): Promise<FileResult>;
  /** `transfer.cancel`: stops a user's upload or download, or voids its unused URL. */
  cancelTransfer(userId: string, transferId: string): void;
  /** A revoked user or auth session (sign-out, password change, ban): its transfers stop. */
  revokeTransfers(target: { userId?: string; authSessionId?: string }): void;
  /** What the `/transfer/*` routes need; absent: the listener has no transfer routes. */
  readonly transferBackend?: TransferBackend;
}
