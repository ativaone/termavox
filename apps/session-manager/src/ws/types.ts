import type { ServerMessage, SessionSummary } from '@termdock/protocol';
import type { SessionHost } from '../core/types.ts';

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
