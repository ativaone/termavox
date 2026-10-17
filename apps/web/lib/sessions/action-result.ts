import type { RemoteSessionInfo } from '../internal-api.ts';

/** Outcome of a session Server Action (lib/actions/sessions.ts). */
export type SessionActionResult = { ok: true; sessionId?: string } | SessionActionFailure;

export interface SessionActionFailure {
  ok: false;
  /** Machine code: the daemon's error code, or UNAVAILABLE / TIMEOUT / BAD_RESPONSE. */
  code: string;
  /** Localized message for the user. */
  message: string;
}

/** Outcome of `renameSession`: on success, the label as the daemon stored it. */
export type RenameSessionResult =
  | { ok: true; sessionId: string; label: string }
  | SessionActionFailure;

/** Outcome of `terminateAllSessions` ("End all sessions", D-30): how many started ending. */
export type TerminateAllResult = { ok: true; terminated: number } | SessionActionFailure;

/** Outcome of `removeEndedSessions` ("Remove all ended", D-32): how many were deleted. */
export type RemoveEndedResult = { ok: true; removed: number } | SessionActionFailure;

/**
 * Outcome of "Check now" on a server page (D-30, lib/actions/remote-sessions.ts): the Termdock
 * tmux servers there that this installation does not run, and how many leftovers of sessions the
 * user had already ended were ended by the check (`cleaned`). A check that could not sign in is a
 * failure whose `code` is the daemon's connection error code.
 */
export type RemoteScanResult =
  | {
      ok: true;
      sessions: RemoteSessionInfo[];
      cleaned: number;
      /** The server had more than the daemon reads; the rest is not listed. */
      truncated: boolean;
      /** When the check answered (epoch ms). */
      at: number;
    }
  | SessionActionFailure;

/** Outcome of ending one remote session: `terminated: false` when it was already gone. */
export type RemoteEndResult = { ok: true; terminated: boolean } | SessionActionFailure;

/** Outcome of adopting a remote session: the new session to open (`/workspace?open=`). */
export type AdoptResult = { ok: true; sessionId: string } | SessionActionFailure;
