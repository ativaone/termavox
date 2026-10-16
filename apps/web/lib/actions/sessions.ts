'use server';

import { Viewport } from '@termdock/protocol';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { requireSession } from '../auth/server.ts';
import { getInternalApi, isInternalApiError } from '../internal-api.ts';
import { serviceErrorKey } from '../manage/service-errors.ts';
import type { SessionActionResult } from '../sessions/action-result.ts';

/**
 * Session lifecycle Server Actions (plan §8.2): create, terminate, retry and reopen go to the
 * daemon's internal API as the signed-in user (`actingUserId`), which re-validates ownership.
 * The UI then follows the session through `session.upsert` / `session.status` on the WebSocket.
 * Called programmatically by the workspace (palette, sidebar menu, pane overlays).
 */

const SessionId = z.string().min(1).max(64);
const CreateInput = z.object({
  profileId: z.string().min(1).max(64),
  label: z.string().trim().max(120).optional(),
  viewport: Viewport,
});

async function failure(err: unknown): Promise<SessionActionResult> {
  if (!isInternalApiError(err)) throw err;
  const t = await getTranslations('manage.sessionError');
  const key = serviceErrorKey(err);
  // A conflict here means the session cannot be reopened (still protected and running).
  const message =
    err.code === 'LOCAL_SHELL_DISABLED'
      ? t('localShellDisabled')
      : key === 'conflict'
        ? t('reopenConflict')
        : t(key);
  return { ok: false, code: err.code, message };
}

async function invalid(): Promise<SessionActionResult> {
  const t = await getTranslations('manage.sessionError');
  return { ok: false, code: 'BAD_REQUEST', message: t('rejected') };
}

export async function createSession(input: {
  profileId: string;
  label?: string;
  viewport: { cols: number; rows: number };
}): Promise<SessionActionResult> {
  const { user } = await requireSession();
  const parsed = CreateInput.safeParse(input);
  if (!parsed.success) return invalid();
  const { profileId, label, viewport } = parsed.data;
  try {
    const { sessionId } = await getInternalApi().createSession({
      actingUserId: user.id,
      profileId,
      ...(label ? { label } : {}),
      viewport,
    });
    return { ok: true, sessionId };
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

/** New shell, same session id; only for ended or unprotected sessions (409 otherwise). */
export async function reopenSession(sessionId: string): Promise<SessionActionResult> {
  const { user } = await requireSession();
  if (!SessionId.safeParse(sessionId).success) return invalid();
  try {
    const result = await getInternalApi().reopenSession(sessionId, user.id);
    return { ok: true, sessionId: result.sessionId };
  } catch (err) {
    return failure(err);
  }
}
