/** Outcome of a session Server Action (lib/actions/sessions.ts). */
export type SessionActionResult =
  | { ok: true; sessionId?: string }
  | {
      ok: false;
      /** Machine code: the daemon's error code, or UNAVAILABLE / TIMEOUT / BAD_RESPONSE. */
      code: string;
      /** Localized message for the user. */
      message: string;
    };
