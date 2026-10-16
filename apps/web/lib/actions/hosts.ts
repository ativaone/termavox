'use server';

import { Fingerprint } from '@termdock/protocol';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isAdminRole } from '../admin/core.ts';
import { getAuthRuntime, requireSession } from '../auth/server.ts';
import { getInternalApi, isInternalApiError } from '../internal-api.ts';
import {
  HOST_ISSUES,
  localizeIssues,
  type ManageState,
  PROFILE_ISSUES,
  readHostForm,
  readProfileForm,
  text,
} from '../manage/forms.ts';
import { summarizeProbe } from '../manage/probe.ts';
import { serviceErrorKey } from '../manage/service-errors.ts';
import { createHost, deleteHost as deleteHostRow, getHost, updateHost } from '../repo/hosts.ts';
import { getInstanceSettings } from '../repo/instance-settings.ts';
import {
  createProfile,
  deleteProfile as deleteProfileRow,
  getProfile,
  updateProfile,
} from '../repo/profiles.ts';
import { type DiagnosticsState, DOCKER_HOSTNAME, type DockerPresetState } from './host-states.ts';

/**
 * Hosts, connection profiles and host diagnostics (plan §8.1 /hosts). Hosts and profiles are
 * written by web through the user-scoped repository; host keys and credentials go through the
 * daemon's internal API as the signed-in user. Every action re-checks ownership.
 */

const hostPath = (id: string) => `/hosts/${encodeURIComponent(id)}`;

// ── hosts ───────────────────────────────────────────────────────────────────

export async function saveHost(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('hosts.error');
  const tn = await getTranslations('hosts.notice');
  const { db } = getAuthRuntime();
  const id = text(formData, 'id');
  const { parsed, values } = readHostForm(formData);
  if (!parsed.success) {
    return { fields: localizeIssues(parsed.error, HOST_ISSUES, (key) => t(key)), values };
  }
  const input = parsed.data;
  if (input.kind === 'local') {
    const visible = getInstanceSettings(db).localShellVisible;
    if (!visible || !isAdminRole(user.role)) return { fields: { kind: t('kindLocal') }, values };
  }
  if (!id) {
    const newId = createHost(db, user.id, input);
    redirect(`${hostPath(newId)}?done=hostCreated`);
  }
  if (!updateHost(db, user.id, id, input)) return { message: t('notFound'), values };
  revalidatePath(hostPath(id));
  return { notice: tn('hostSaved'), savedAt: Date.now(), values };
}

export async function deleteHost(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('hosts.error');
  const outcome = deleteHostRow(getAuthRuntime().db, user.id, text(formData, 'id'));
  if (outcome === 'conflict') return { message: t('hostInUse') };
  if (outcome === 'not_found') return { message: t('notFound') };
  redirect('/hosts?done=hostDeleted');
}

// ── profiles ────────────────────────────────────────────────────────────────

export async function saveProfile(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('hosts.profile.error');
  const { db } = getAuthRuntime();
  const hostId = text(formData, 'hostId');
  const id = text(formData, 'id');
  const { parsed, duplicate, values } = readProfileForm(formData);
  if (!parsed.success) {
    return { fields: localizeIssues(parsed.error, PROFILE_ISSUES, (key) => t(key)), values };
  }
  if (duplicate) return { fields: { env: t(duplicate) }, values };
  const { env, ...rest } = parsed.data;
  const input = { ...rest, env: Object.fromEntries(env.map((p) => [p.key, p.value])) };
  if (!getHost(db, user.id, hostId)) return { message: t('notFound'), values };
  if (id) {
    const existing = getProfile(db, user.id, id);
    if (!existing || existing.hostId !== hostId) return { message: t('notFound'), values };
    const outcome = updateProfile(db, user.id, id, input);
    if (outcome === 'credential_not_found') {
      return { fields: { credentialId: t('credential') }, values };
    }
    if (outcome === 'not_found') return { message: t('notFound'), values };
    redirect(`${hostPath(hostId)}?done=profileSaved#profiles`);
  }
  const created = createProfile(db, user.id, hostId, input);
  if (created.outcome === 'credential_not_found') {
    return { fields: { credentialId: t('credential') }, values };
  }
  if (created.outcome === 'not_found') return { message: t('notFound'), values };
  redirect(`${hostPath(hostId)}?done=profileCreated#profiles`);
}

export async function deleteProfile(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('hosts.profile.error');
  const hostId = text(formData, 'hostId');
  const outcome = deleteProfileRow(getAuthRuntime().db, user.id, text(formData, 'id'));
  if (outcome === 'conflict') return { message: t('inUse') };
  if (outcome === 'not_found') return { message: t('notFound') };
  redirect(`${hostPath(hostId)}?done=profileDeleted#profiles`);
}

// ── diagnostics ─────────────────────────────────────────────────────────────

/** "Fetch & verify": connects, records an unknown key as pending, and probes with a profile. */
export async function fetchHostKey(
  _prev: DiagnosticsState,
  formData: FormData,
): Promise<DiagnosticsState> {
  const { user } = await requireSession();
  const t = await getTranslations('hosts.diagnostics.error');
  const { db } = getAuthRuntime();
  const hostId = text(formData, 'hostId');
  const profileId = text(formData, 'profileId') || undefined;
  const profile = profileId ? getProfile(db, user.id, profileId) : null;
  if (profileId && (!profile || profile.hostId !== hostId)) return { message: t('profile') };
  try {
    const result = await getInternalApi().testHost(hostId, user.id, profileId);
    revalidatePath(hostPath(hostId));
    return {
      at: Date.now(),
      profileName: profile?.name ?? null,
      result: {
        reachable: result.reachable,
        error: result.error,
        hostKey: result.hostKey,
        probe: result.probe ? summarizeProbe(result.probe, profile?.protectionMode) : null,
      },
    };
  } catch (err) {
    if (!isInternalApiError(err)) throw err;
    return { message: t(serviceErrorKey(err)) };
  }
}

async function keyAction(
  formData: FormData,
  run: (args: { hostId: string; userId: string; hostName: string }) => Promise<void>,
  done: string,
): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('hosts.diagnostics.error');
  const hostId = text(formData, 'hostId');
  const host = getHost(getAuthRuntime().db, user.id, hostId);
  if (!host) return { message: t('notFound') };
  try {
    await run({ hostId, userId: user.id, hostName: host.name });
  } catch (err) {
    if (!isInternalApiError(err)) throw err;
    if (err.kind === 'conflict') return { message: t('trustConflict') };
    if (err.kind === 'not_found') return { message: t('keyNotFound') };
    return { message: t(serviceErrorKey(err)) };
  }
  redirect(`${hostPath(hostId)}?done=${done}#diagnostics`);
}

function fingerprintOf(formData: FormData): string | null {
  const parsed = Fingerprint.safeParse(text(formData, 'fingerprint'));
  return parsed.success ? parsed.data : null;
}

/** Trusts the pending key with exactly this fingerprint. */
export async function trustHostKey(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const fingerprint = fingerprintOf(formData);
  const keyType = text(formData, 'keyType');
  if (!fingerprint || !keyType) {
    const t = await getTranslations('hosts.diagnostics.error');
    return { message: t('fingerprint') };
  }
  return keyAction(
    formData,
    ({ hostId, userId }) =>
      getInternalApi().trustHostKey(hostId, { actingUserId: userId, keyType, fingerprint }),
    'keyTrusted',
  );
}

/** Pre-trust: records a fingerprint the user got from the host's administrator. */
export async function pretrustFingerprint(
  _prev: ManageState,
  formData: FormData,
): Promise<ManageState> {
  const t = await getTranslations('hosts.diagnostics.error');
  const keyType = text(formData, 'keyType');
  const fingerprint = fingerprintOf(formData);
  if (!fingerprint) {
    return { fields: { fingerprint: t('fingerprint') }, values: { keyType } };
  }
  return keyAction(
    formData,
    ({ hostId, userId }) =>
      getInternalApi().trustHostKey(hostId, { actingUserId: userId, keyType, fingerprint }),
    'keyPretrusted',
  );
}

/** After a mismatch: revokes the trusted key of that type and trusts the given fingerprint. */
export async function replaceHostKey(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const { user } = await requireSession();
  const t = await getTranslations('hosts.diagnostics.error');
  const keyType = text(formData, 'keyType');
  const confirmHostName = text(formData, 'confirmHostName');
  const fingerprint = fingerprintOf(formData);
  const values = { keyType, fingerprint: text(formData, 'fingerprint') };
  const fields: Record<string, string> = {};
  if (!fingerprint) fields.fingerprint = t('fingerprint');
  const host = getHost(getAuthRuntime().db, user.id, text(formData, 'hostId'));
  if (!host) return { message: t('notFound') };
  if (confirmHostName !== host.name) fields.confirmHostName = t('confirmName');
  if (Object.keys(fields).length > 0 || !fingerprint) return { fields, values };
  return keyAction(
    formData,
    ({ hostId, userId, hostName }) =>
      getInternalApi().replaceHostKey(hostId, {
        actingUserId: userId,
        keyType,
        fingerprint,
        confirmHostName: hostName,
      }),
    'keyReplaced',
  );
}

export async function revokeHostKey(_prev: ManageState, formData: FormData): Promise<ManageState> {
  const keyType = text(formData, 'keyType');
  return keyAction(
    formData,
    ({ hostId, userId }) =>
      getInternalApi().revokeHostKey(hostId, { actingUserId: userId, keyType }),
    'keyRevoked',
  );
}

// ── "Add this Docker host" preset (plan §13.4) ──────────────────────────────

/**
 * Generates an ed25519 credential first (nothing is created if the daemon cannot), then the host
 * `host.docker.internal:22` and a profile for the given host user, and returns the public key
 * for the host's `authorized_keys`. The first connection goes through the normal trust flow.
 */
export async function addDockerHost(
  _prev: DockerPresetState,
  formData: FormData,
): Promise<DockerPresetState> {
  const { user } = await requireSession();
  const t = await getTranslations('hosts.docker.error');
  const tn = await getTranslations('hosts.docker');
  const username = text(formData, 'username').trim();
  if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(username)) {
    return { fields: { username: t('username') }, values: { username } };
  }
  const { db } = getAuthRuntime();
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
  if (!publicKey) return { message: t('generic'), values: { username } };
  const hostId = createHost(db, user.id, {
    name: tn('hostName'),
    kind: 'ssh',
    hostname: DOCKER_HOSTNAME,
    port: 22,
  });
  createProfile(db, user.id, hostId, {
    name: username,
    username,
    credentialId,
    protectionMode: 'auto',
    startupCommand: null,
    env: {},
    keepaliveIntervalS: 15,
    autoReopen: true,
    scrollbackLines: 5_000,
  });
  return { created: { hostId, publicKey, fingerprint, username } };
}
