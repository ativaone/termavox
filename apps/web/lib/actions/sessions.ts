'use server';

import { SessionLabelInput, Viewport } from '@termdock/protocol';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { requireSession } from '../auth/server.ts';
import { getInternalApi, isInternalApiError } from '../internal-api.ts';
import { serviceErrorKey } from '../manage/service-errors.ts';
import type {
  RemoveEndedResult,
  RenameSessionResult,
  SessionActionFailure,
  SessionActionResult,
  TerminateAllResult,
} from '../sessions/action-result.ts';

/**
 * Session lifecycle Server Actions (plan §8.2): create, rename, terminate (one or all, D-30), retry,
 * stop (D-31), reopen and remove (one or all ended, D-32) go to the daemon's internal API as the signed-in user (`actingUserId`), which
 * re-validates ownership.
 * The UI then follows the session through `session.upsert` / `session.status` on the WebSocket.
 * Called programmatically by the workspace (palette, sidebar menu, pane overlays).
 *
 * Every action resolves (never throws for a refusal) with `{ ok: true, … }` or
 * `{ ok: false, code, message }`: `code` is the daemon's error code (`NOT_FOUND`, `FORBIDDEN`,
 * `RATE_LIMITED`, `CONFLICT`, `LABEL_INVALID`, `BAD_REQUEST`, …) or `UNAVAILABLE` / `TIMEOUT` /
 * `BAD_RESPONSE` when the daemon did not answer usefully; `message` is localized
 * (`manage.sessionError.*`). Not signed in: `requireSession` redirects to the login page.
 */

const SessionId = z.string().min(1).max(64);
const CreateInput = z.object({
  serverId: z.string().min(1).max(64),
  label: SessionLabelInput.optional(),
  viewport: Viewport,
});

/** What a CONFLICT means for the action that got it. */
type ConflictKey = 'conflict' | 'reopenConflict' | 'stopConflict' | 'removeConflict';

async function failure(
  err: unknown,
  conflict: ConflictKey = 'conflict',
): Promise<SessionActionFailure> {
  if (!isInternalApiError(err)) throw err;
  const t = await getTranslations('manage.sessionError');
  const key = serviceErrorKey(err);
  const message =
    err.code === 'LOCAL_SHELL_DISABLED'
      ? t('localShellDisabled')
      : err.code === 'LABEL_INVALID'
        ? t('labelInvalid')
        : key === 'conflict'
          ? t(conflict)
          : t(key);
  return { ok: false, code: err.code, message };
}

async function invalid(): Promise<SessionActionFailure> {
  const t = await getTranslations('manage.sessionError');
  return { ok: false, code: 'BAD_REQUEST', message: t('rejected') };
}

/**
 * Opens a session from one of the user's servers (plan D-29).
 *
 * @param input.serverId The server to connect to (its target is snapshotted at creation, §9).
 * @param input.label Optional name (D-28). Blank or absent: the server's name.
 *   Otherwise the daemon drops control and invisible formatting characters, trims, and needs
 *   1–120 characters left (`LABEL_INVALID` otherwise); raw input above 1024 characters is
 *   `BAD_REQUEST`.
 * @param input.viewport The first pane's grid (20–500 × 5–200).
 * @returns `{ ok: true, sessionId }`, or a failure: `LABEL_INVALID`, `NOT_FOUND` (server or
 *   credential gone), `RATE_LIMITED` (running-session cap), `LOCAL_SHELL_DISABLED`, `FORBIDDEN`,
 *   `BAD_REQUEST`, `UNAVAILABLE` / `TIMEOUT` / `BAD_RESPONSE`.
 */
export async function createSession(input: {
  serverId: string;
  label?: string;
  viewport: { cols: number; rows: number };
}): Promise<SessionActionResult> {
  const { user } = await requireSession();
  const parsed = CreateInput.safeParse(input);
  if (!parsed.success) return invalid();
  const { serverId, label, viewport } = parsed.data;
  try {
    const { sessionId } = await getInternalApi().createSession({
      actingUserId: user.id,
      serverId,
      ...(label?.trim() ? { label } : {}),
      viewport,
    });
    return { ok: true, sessionId };
  } catch (err) {
    return failure(err);
  }
}

/**
 * Renames a session of the signed-in user (D-28), in any state, ended included. Every browser of
 * the user, this one too, then gets the new label through `session.upsert` on its WebSocket;
 * `useRenameSession` (components/workspace/hooks.ts) also applies the result at once in the
 * renaming tab.
 *
 * @param sessionId The session to rename.
 * @param label The new name as typed. The daemon drops control characters and invisible formatting
 *   (bidi controls, zero-width characters), trims, and needs 1–120 characters left.
 * @returns `{ ok: true, sessionId, label }` with the label as stored (cleaned and trimmed), or a
 *   failure: `LABEL_INVALID` (nothing left, or over 120 characters; message
 *   `manage.sessionError.labelInvalid`), `NOT_FOUND` (missing or another user's session),
 *   `FORBIDDEN` (acting user disabled), `BAD_REQUEST` (malformed id, non-string label or raw
 *   label above 1024 characters), `UNAVAILABLE` / `TIMEOUT` / `BAD_RESPONSE`.
 */
export async function renameSession(
  sessionId: string,
  label: string,
): Promise<RenameSessionResult> {
  const { user } = await requireSession();
  if (!SessionId.safeParse(sessionId).success || !SessionLabelInput.safeParse(label).success) {
    return invalid();
  }
  try {
    const renamed = await getInternalApi().renameSession(sessionId, user.id, label);
    return { ok: true, sessionId: renamed.sessionId, label: renamed.label };
  } catch (err) {
    return failure(err);
  }
}

export async function terminateSession(sessionId: string): Promise<SessionActionResult> {
  const { user } = await requireSession();
  if (!SessionId.safeParse(sessionId).success) return invalid();
  try {
    await getInternalApi().terminateSession(sessionId, user.id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/**
 * "End all sessions" (plan D-30): every session of the signed-in user that has not ended starts
 * ending, on its server too (a protected session's tmux is ended there, or as soon as Termdock can
 * reach the server again). Resolves once each one is ending; the ends arrive on the WebSocket as
 * `session.status`.
 *
 * @returns `{ ok: true, terminated }` (how many started ending), or a failure: `FORBIDDEN`,
 *   `UNAVAILABLE` / `TIMEOUT` / `BAD_RESPONSE` (message `manage.sessionError.*`).
 */
export async function terminateAllSessions(): Promise<TerminateAllResult> {
  const { user } = await requireSession();
  try {
    const { terminated } = await getInternalApi().terminateAllSessions(user.id);
    return { ok: true, terminated };
  } catch (err) {
    if (!isInternalApiError(err)) throw err;
    const t = await getTranslations('manage.sessionError');
    return { ok: false, code: err.code, message: t(serviceErrorKey(err)) };
  }
}

/** "Retry now": restarts the connect loop, skipping any remaining backoff wait. */
export async function retrySession(sessionId: string): Promise<SessionActionResult> {
  const { user } = await requireSession();
  if (!SessionId.safeParse(sessionId).success) return invalid();
  try {
    await getInternalApi().retrySession(sessionId, user.id);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}

/**
 * "Stop" (plan D-31): ends the session's connection retries; it then waits as Disconnected for
 * Retry or End. CONFLICT when it is not retrying (connected, or waiting already).
 */
export async function stopSession(sessionId: string): Promise<SessionActionResult> {
  const { user } = await requireSession();
  if (!SessionId.safeParse(sessionId).success) return invalid();
  try {
    await getInternalApi().stopSession(sessionId, user.id);
    return { ok: true };
  } catch (err) {
    return failure(err, 'stopConflict');
  }
}

/**
 * "Remove" (plan D-32): deletes an ended session with its history; CONFLICT when it has not
 * ended. Its panes learn it from the WebSocket (`session.removed`).
 */
export async function removeSession(sessionId: string): Promise<SessionActionResult> {
  const { user } = await requireSession();
  if (!SessionId.safeParse(sessionId).success) return invalid();
  try {
    await getInternalApi().removeSession(sessionId, user.id);
    return { ok: true };
  } catch (err) {
    return failure(err, 'removeConflict');
  }
}

/** "Remove all ended…" (plan D-32): deletes every ended session of the signed-in user. */
export async function removeEndedSessions(): Promise<RemoveEndedResult> {
  const { user } = await requireSession();
  try {
    const { removed } = await getInternalApi().removeEndedSessions(user.id);
    return { ok: true, removed };
  } catch (err) {
    if (!isInternalApiError(err)) throw err;
    const t = await getTranslations('manage.sessionError');
    return { ok: false, code: err.code, message: t(serviceErrorKey(err)) };
  }
}

/** New shell, same session id; only for ended or unprotected sessions (409 otherwise). */
export async function reopenSession(sessionId: string): Promise<SessionActionResult> {
  const { user } = await requireSession();
  if (!SessionId.safeParse(sessionId).success) return invalid();
  try {
    const result = await getInternalApi().reopenSession(sessionId, user.id);
    return { ok: true, sessionId: result.sessionId };
  } catch (err) {
    return failure(err, 'reopenConflict');
  }
}
