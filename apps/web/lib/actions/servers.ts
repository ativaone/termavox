'use server';

import { Fingerprint } from '@termdock/protocol';
import { normalizeHostname } from '@termdock/shared';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requestMeta } from '../auth/audit-plugin.ts';
import { getAuthRuntime, requireSession } from '../auth/server.ts';
import { getInternalApi, isInternalApiError } from '../internal-api.ts';
import {
  localizeIssues,
  type ManageState,
  readServerForm,
  SERVER_ISSUES,
  text,
  toServerInput,
} from '../manage/forms.ts';
import { localKindAvailability } from '../manage/local-kind.ts';
import { summarizeProbe } from '../manage/probe.ts';
import { serviceErrorKey } from '../manage/service-errors.ts';
import { getInstanceSettings } from '../repo/instance-settings.ts';
import {
  createServer,
  deleteServer as deleteServerRow,
  getServer,
  type Server,
  updateServer,
} from '../repo/servers.ts';
import { ROUTES, serverPath } from '../routes.ts';
import { type DiagnosticsState, DOCKER_HOSTNAME, type DockerPresetState } from './server-states.ts';

/**
 * The server page's actions (plan D-29, §8.1 /servers/[id]): edit, delete, "Test connection" and
 * host-key decisions, plus the Docker host preset. Servers are written by web through the
 * user-scoped repository (with their `server.*` audit rows); host keys and credentials go through
 * the daemon's internal API as the signed-in user. Every action re-checks ownership.
 */

async function auditMeta() {
  return requestMeta(await headers(), getAuthRuntime().auth.options);
}

// ── edit and delete ─────────────────────────────────────────────────────────

export async function saveServer(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('servers.error');
  const { db } = getAuthRuntime();
  const id = text(formData, 'id');
  const { parsed, duplicate, values } = readServerForm(formData);
  const credentialId = text(formData, 'credentialId').trim();
  const echoed = { ...values, credentialId };
  if (!parsed.success) {
    return { fields: localizeIssues(parsed.error, SERVER_ISSUES, (key) => t(key)), values: echoed };
  }
  if (duplicate) return { fields: { env: t(duplicate) }, values: echoed };
  if (
    parsed.data.kind === 'local' &&
    !localKindAvailability(getInstanceSettings(db), user.role).allowed
  ) {
    return { fields: { kind: t('kindLocal') }, values: echoed };
  }
  const outcome = updateServer(
    db,
    user.id,
    id,
    toServerInput(parsed.data, credentialId || null),
    await auditMeta(),
  );
  if (outcome === 'credential_not_found') {
    return { fields: { credentialId: t('credential') }, values: echoed };
  }
  if (outcome === 'not_found') return { message: t('notFound'), values: echoed };
  revalidatePath(ROUTES.servers);
  revalidatePath(ROUTES.workspace);
  redirect(`${serverPath(id)}?done=serverSaved`);
}

export async function deleteServer(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('servers.error');
  const outcome = deleteServerRow(
    getAuthRuntime().db,
    user.id,
    text(formData, 'id'),
    await auditMeta(),
  );
  if (outcome === 'conflict') return { message: t('inUse') };
  if (outcome === 'not_found') return { message: t('notFound') };
  revalidatePath(ROUTES.workspace);
  redirect(`${ROUTES.servers}?done=serverDeleted`);
}

// ── diagnostics ─────────────────────────────────────────────────────────────

/**
 * "Test connection": connects to the server's address, records an unknown key as pending for
 * that address, and (once the key is trusted) signs in as the server's user and probes it.
 */
export async function testServer(
  _prev: DiagnosticsState,
  formData: FormData,
): Promise<DiagnosticsState> {
  const { user } = await requireSession();
  const t = await getTranslations('servers.diagnostics.error');
  const server = getServer(getAuthRuntime().db, user.id, text(formData, 'serverId'));
  if (!server) return { message: t('notFound') };
  try {
    const result = await getInternalApi().testServer(server.id, user.id);
    revalidatePath(serverPath(server.id));
    return {
      at: Date.now(),
      result: {
        reachable: result.reachable,
        error: result.error,
        hostKey: result.hostKey,
        probe: result.probe ? summarizeProbe(result.probe, server.protectionMode) : null,
        ...(result.revoked ? { revoked: true } : {}),
      },
    };
  } catch (err) {
    if (!isInternalApiError(err)) throw err;
    // The daemon allows a few connection tests per user and minute.
    if (err.kind === 'rate_limited') return { message: t('testLimit') };
    return { message: t(serviceErrorKey(err)) };
  }
}

async function keyAction(
  formData: FormData,
  run: (args: { server: Server; userId: string }) => Promise<void>,
  done: string,
): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('servers.diagnostics.error');
  const server = getServer(getAuthRuntime().db, user.id, text(formData, 'serverId'));
  if (server?.kind !== 'ssh') return { message: t('notFound') };
  try {
    await run({ server, userId: user.id });
  } catch (err) {
    if (!isInternalApiError(err)) throw err;
    if (err.kind === 'conflict') return { message: t('trustConflict') };
    if (err.kind === 'not_found') return { message: t('keyNotFound') };
    return { message: t(serviceErrorKey(err)) };
  }
  redirect(`${serverPath(server.id)}?done=${done}#diagnostics`);
}

function fingerprintOf(formData: FormData): string | null {
  const parsed = Fingerprint.safeParse(text(formData, 'fingerprint'));
  return parsed.success ? parsed.data : null;
}

/** Trusts the pending key with exactly this fingerprint, for the server's address. */
export async function trustHostKey(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const fingerprint = fingerprintOf(formData);
  const keyType = text(formData, 'keyType');
  if (!fingerprint || !keyType) {
    const t = await getTranslations('servers.diagnostics.error');
    return { message: t('fingerprint') };
  }
  return keyAction(
    formData,
    ({ server, userId }) =>
      getInternalApi().trustHostKey(server.id, { actingUserId: userId, keyType, fingerprint }),
    'keyTrusted',
  );
}

/** Pre-trust: records a fingerprint the user got from the server's administrator. */
export async function pretrustFingerprint(
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  const t = await getTranslations('servers.diagnostics.error');
  const keyType = text(formData, 'keyType');
  const fingerprint = fingerprintOf(formData);
  if (!fingerprint) {
    return { fields: { fingerprint: t('fingerprint') }, values: { keyType } };
  }
  return keyAction(
    formData,
    ({ server, userId }) =>
      getInternalApi().trustHostKey(server.id, { actingUserId: userId, keyType, fingerprint }),
    'keyPretrusted',
  );
}

/**
 * After a mismatch: revokes the trusted key of that type and trusts the given fingerprint, for
 * every server of the user at this address. The user types the address to confirm; case and
 * IPv6 brackets do not matter (it is compared normalized), and the daemon gets the stored one.
 */
export async function replaceHostKey(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('servers.diagnostics.error');
  const keyType = text(formData, 'keyType');
  const typed = text(formData, 'confirmHostname');
  const fingerprint = fingerprintOf(formData);
  const values = { keyType, fingerprint: text(formData, 'fingerprint'), confirmHostname: typed };
  const server = getServer(getAuthRuntime().db, user.id, text(formData, 'serverId'));
  if (server?.kind !== 'ssh' || server.hostname === null) {
    return { message: t('notFound') };
  }
  const hostname = server.hostname;
  const fields: Record<string, string> = {};
  if (!fingerprint) fields.fingerprint = t('fingerprint');
  if (!typed.trim() || normalizeHostname(typed) !== hostname) {
    fields.confirmHostname = t('confirmHostname');
  }
  if (Object.keys(fields).length > 0 || !fingerprint) return { fields, values };
  return keyAction(
    formData,
    ({ userId }) =>
      getInternalApi().replaceHostKey(server.id, {
        actingUserId: userId,
        keyType,
        fingerprint,
        confirmHostname: hostname,
      }),
    'keyReplaced',
  );
}

export async function revokeHostKey(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const keyType = text(formData, 'keyType');
  return keyAction(
    formData,
    ({ server, userId }) =>
      getInternalApi().revokeHostKey(server.id, { actingUserId: userId, keyType }),
    'keyRevoked',
  );
}

// ── "Add this Docker host" preset (plan §13.4) ──────────────────────────────

/**
 * Generates an ed25519 credential first (nothing is created if the daemon cannot), then the
 * server `user@host.docker.internal` with it, and returns the public key for the user's
 * `authorized_keys`. The first connection goes through the normal trust flow.
 */
export async function addDockerServer(
  _prev: DockerPresetState,
  formData: FormData,
): Promise<DockerPresetState> {
  const { user } = await requireSession();
  const t = await getTranslations('servers.docker.error');
  const tn = await getTranslations('servers.docker');
  const username = text(formData, 'username').trim();
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(username)) {
    return { fields: { username: t('username') }, values: { username } };
  }
  const { db, logger } = getAuthRuntime();
  let credentialId: string;
  let publicKey: string | null;
  let fingerprint: string | null;
  try {
    ({ credentialId, publicKey, fingerprint } = await getInternalApi().createCredential({
      actingUserId: user.id,
      kind: 'generate',
      algorithm: 'ed25519',
      name: tn('credentialName'),
    }));
  } catch (err) {
    if (!isInternalApiError(err)) throw err;
    return { message: t(serviceErrorKey(err)), values: { username } };
  }
  const created = publicKey
    ? createServer(
        db,
        user.id,
        {
          name: tn('serverName'),
          kind: 'ssh',
          hostname: DOCKER_HOSTNAME,
          port: 22,
          username,
          credentialId,
          protectionMode: 'auto',
          startupCommand: null,
          env: {},
          keepaliveIntervalS: 15,
          autoReopen: true,
          scrollbackLines: 5_000,
        },
        await auditMeta(),
      )
    : null;
  if (!publicKey || created?.outcome !== 'ok') {
    // Nothing usable came of it: remove the key again rather than leave it behind.
    try {
      await getInternalApi().deleteCredential(credentialId, user.id);
    } catch (err) {
      logger.warn('docker preset: could not delete the credential it created', {
        credentialId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { message: t('generic'), values: { username } };
  }
  revalidatePath(ROUTES.servers);
  revalidatePath(ROUTES.workspace);
  return { created: { serverId: created.id, publicKey, fingerprint, username } };
}
