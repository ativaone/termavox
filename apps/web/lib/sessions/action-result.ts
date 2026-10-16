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
