'use server';

import { RemoteSocketName, SessionLabelInput } from '@termdock/protocol';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { getAuthRuntime, requireSession } from '../auth/server.ts';
import { getInternalApi, isInternalApiError } from '../internal-api.ts';
import { connectCodeKey } from '../manage/connect-codes.ts';
import { serviceErrorKey } from '../manage/service-errors.ts';
import { getServer, listServerHostKeys, type Server } from '../repo/servers.ts';
import { ROUTES, serverPath } from '../routes.ts';
import type {
  AdoptResult,
  RemoteEndResult,
  RemoteScanResult,
  SessionActionFailure,
} from '../sessions/action-result.ts';

/**
 * Remote tmux leftovers on a server page (plan D-30): "Check now" lists the Termdock tmux servers
 * on the server that this installation does not run, and each can be ended or adopted. Every call
 * connects to the server as its user through the daemon, which never prompts (the server's stored
 * credential, its address's trusted host key) and re-validates ownership; web checks first that
 * the server is one of the signed-in user's SSH servers.
 *
 * Every action resolves (never throws for a refusal) with `{ ok: true, … }` or
 * `{ ok: false, code, message }`: `code` is the daemon's error code (a connection code such as
 * `HOST_UNREACHABLE`, or `CONFLICT`, `NOT_FOUND`, `RATE_LIMITED`, …), `UNAVAILABLE` / `TIMEOUT` /
 * `BAD_RESPONSE` when the daemon did not answer usefully, or `BAD_REQUEST` for malformed input;
 * `message` is localized. Not signed in: `requireSession` redirects to the login page.
 */

const ServerId = z.string().min(1).max(64);

type Action = 'scan' | 'end' | 'adopt';

async function rejected(): Promise<SessionActionFailure> {
  const t = await getTranslations('servers.diagnostics.error');
  return { ok: false, code: 'BAD_REQUEST', message: t('rejected') };
}

async function missing(): Promise<SessionActionFailure> {
  const t = await getTranslations('servers.diagnostics.error');
  return { ok: false, code: 'NOT_FOUND', message: t('notFound') };
}

/** One of the user's SSH servers (the only kind with a remote tmux), or null. */
function sshServer(userId: string, serverId: string): Server | null {
  const server = getServer(getAuthRuntime().db, userId, serverId);
  return server?.kind === 'ssh' ? server : null;
}

/**
 * Why the daemon could not sign in to the server. `CREDENTIAL_REQUIRED`: no stored credential, so
 * nothing was contacted (the daemon never asks for a password). A refusal before the sign-in
 * (unreachable, a mismatched key) reads as such; otherwise the likely cause on this page comes
 * first: no trusted host key yet, then no stored credential.
 */
async function connectMessage(userId: string, server: Server, code: string): Promise<string> {
  const t = await getTranslations('servers.remote.error');
  const td = await getTranslations('servers.diagnostics.code');
  if (code === 'CREDENTIAL_REQUIRED') return t('noCredential');
  const key = connectCodeKey(code);
  const beforeSignIn =
    key === 'HOST_UNREACHABLE' || key === 'TARGET_NOT_ALLOWED' || key === 'HOST_KEY_MISMATCH';
  if (!beforeSignIn) {
    const trusted = listServerHostKeys(getAuthRuntime().db, userId, server.id).some(
      (k) => k.status === 'trusted',
    );
    if (!trusted) return t('untrusted');
    if (server.credentialId === null) return t('noCredential');
  }
  return td(key);
}

async function failure(
  err: unknown,
  action: Action,
  userId: string,
  server: Server,
): Promise<SessionActionFailure> {
  if (!isInternalApiError(err)) throw err;
  const t = await getTranslations('servers.diagnostics.error');
  if (err.kind === 'conflict') {
    // The tmux server belongs to a session that runs in Termdock (now): never ended or adopted.
    const tr = await getTranslations('servers.remote.error');
    return { ok: false, code: err.code, message: tr('running') };
  }
  if (err.kind === 'rate_limited') {
    // Adopting opens a session, so the running-session cap applies as for New session.
    const ts = await getTranslations('manage.sessionError');
    const message = action === 'adopt' ? ts('limit') : t('testLimit');
    return { ok: false, code: err.code, message };
  }
  if (err.code === 'LABEL_INVALID') {
    const ts = await getTranslations('manage.sessionError');
    return { ok: false, code: err.code, message: ts('labelInvalid') };
  }
  if (connectCodeKey(err.code) !== 'OTHER' || err.code === 'CREDENTIAL_REQUIRED') {
    return { ok: false, code: err.code, message: await connectMessage(userId, server, err.code) };
  }
  return { ok: false, code: err.code, message: t(serviceErrorKey(err)) };
}

/**
 * "Check now": connects to the server and lists the Termdock tmux servers there that this
 * installation does not run (another installation, this one before a database reset, or one no
 * session record knows). Leftovers of sessions the user already ended are ended first.
 *
 * @param serverId One of the user's SSH servers.
 * @returns `{ ok: true, sessions, cleaned, truncated, at }`, or a failure: the connection code
 *   when the check could not sign in (with the likely cause as message), `NOT_FOUND`,
 *   `RATE_LIMITED`, `UNAVAILABLE` / `TIMEOUT` / `BAD_RESPONSE`, `BAD_REQUEST`.
 */
export async function listRemoteSessions(serverId: string): Promise<RemoteScanResult> {
  const { user } = await requireSession();
  if (!ServerId.safeParse(serverId).success) return rejected();
  const server = sshServer(user.id, serverId);
  if (!server) return missing();
  try {
    const scan = await getInternalApi().listRemoteSessions(server.id, user.id);
    if (scan.error !== null) {
      return {
        ok: false,
        code: scan.error,
        message: await connectMessage(user.id, server, scan.error),
      };
    }
    return {
      ok: true,
      sessions: scan.sessions,
      cleaned: scan.cleaned,
      truncated: scan.truncated,
      at: Date.now(),
    };
  } catch (err) {
    return failure(err, 'scan', user.id, server);
  }
}

/**
 * Ends one listed remote session: the programs running in it stop.
 *
 * @param socket Its tmux server name (`td-<prefix>-<token>`), as the check listed it.
 * @returns `{ ok: true, terminated }` (`false` when it was already gone), or a failure: `CONFLICT`
 *   (it runs in Termdock now), the connection code, `NOT_FOUND`, `UNAVAILABLE` / `TIMEOUT`, ….
 */
export async function terminateRemoteSession(
  serverId: string,
  socket: string,
): Promise<RemoteEndResult> {
  const { user } = await requireSession();
  if (!ServerId.safeParse(serverId).success || !RemoteSocketName.safeParse(socket).success) {
    return rejected();
  }
  const server = sshServer(user.id, serverId);
  if (!server) return missing();
  try {
    const { terminated } = await getInternalApi().terminateRemoteSession(
      server.id,
      socket,
      user.id,
    );
    return { ok: true, terminated };
  } catch (err) {
    return failure(err, 'end', user.id, server);
  }
}

/**
 * Adopts a listed remote session: a new session of this server, attached to that tmux server.
 * The page then opens it in the workspace (`/workspace?open=<sessionId>`).
 *
 * @param label Optional name; blank or absent: the server's name (as for New session).
 * @returns `{ ok: true, sessionId }`, or a failure: `CONFLICT` (it runs in Termdock now),
 *   `RATE_LIMITED` (running-session cap), `LABEL_INVALID`, `NOT_FOUND`, `UNAVAILABLE` / `TIMEOUT`, ….
 */
export async function adoptRemoteSession(
  serverId: string,
  socket: string,
  label?: string,
): Promise<AdoptResult> {
  const { user } = await requireSession();
  if (
    !ServerId.safeParse(serverId).success ||
    !RemoteSocketName.safeParse(socket).success ||
    !SessionLabelInput.optional().safeParse(label).success
  ) {
    return rejected();
  }
  const server = sshServer(user.id, serverId);
  if (!server) return missing();
  try {
    const { sessionId } = await getInternalApi().adoptRemoteSession(
      server.id,
      socket,
      user.id,
      label?.trim() ? label : undefined,
    );
    // A new running session from this server (the Delete card counts them).
    revalidatePath(serverPath(server.id));
    revalidatePath(ROUTES.workspace);
    return { ok: true, sessionId };
  } catch (err) {
    return failure(err, 'adopt', user.id, server);
  }
}
