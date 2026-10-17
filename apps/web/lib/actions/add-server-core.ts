import '../server-guard.ts';
import type { AuthRuntime } from '../auth/runtime.ts';
import {
  type CreateCredentialInput,
  type CreateCredentialResult,
  type InternalApiClient,
  isInternalApiError,
} from '../internal-api.ts';
import type { WebLogger } from '../logger.ts';
import {
  HOST_ISSUES,
  issuesOf,
  PROFILE_ISSUES,
  readHostForm,
  readProfileForm,
  text,
} from '../manage/forms.ts';
import { localKindAvailability } from '../manage/local-kind.ts';
import { type ServiceErrorKey, serviceErrorKey } from '../manage/service-errors.ts';
import { getCredentialName } from '../repo/credentials.ts';
import {
  createHost,
  getHost,
  type HostInput,
  type HostKind,
  type HostSummary,
} from '../repo/hosts.ts';
import { createProfile, type ProfileInput } from '../repo/profiles.ts';
import type { AddServerResult, CredentialChoice } from './add-server-states.ts';

/**
 * The work behind "Add server" (plan D-27), free of Next so T0 tests can drive it with a real
 * database and a fake internal API. One form, three sections, every input namespaced by its
 * section (`host.*`, `profile.*`, `credential.*`); each section is read with the same parser as
 * its own management form.
 *
 * Order: validate all three sections and return every field error at once (nothing written);
 * create a new credential through the daemon (the step most likely to fail, e.g. an unreadable
 * key); then the host (when new) and the profile in one SQLite transaction. If that transaction
 * fails, the credential created a moment before is deleted again. Secrets are never echoed in
 * `values`.
 */

const CREDENTIAL_NAME_MAX = 120;
const PRIVATE_KEY_MAX = 32_768;
const CHOICES: readonly CredentialChoice[] = ['generate', 'private_key', 'password', 'saved'];

type HostIssue = (typeof HOST_ISSUES)[number] | 'invalid' | 'kindLocal';
type ProfileIssue = (typeof PROFILE_ISSUES)[number] | 'invalid' | 'envDuplicate';
type CredentialIssue =
  | 'nameLong'
  | 'passwordRequired'
  | 'privateKeyRequired'
  | 'privateKeyLong'
  | 'privateKeyInvalid';
type AddServerIssue = 'hostRequired' | 'hostMissing' | 'credentialRequired' | 'credentialMissing';

/** A field error as a message key in the catalog of the section that owns the rule. */
export type Issue =
  | { scope: 'host'; key: HostIssue }
  | { scope: 'profile'; key: ProfileIssue }
  | { scope: 'credential'; key: CredentialIssue }
  | { scope: 'addServer'; key: AddServerIssue };

/** A form-level message: why nothing was added (or what was left behind). */
export type AddServerMessage =
  | { key: ServiceErrorKey | 'saveFailed' }
  /** The write failed and the credential created for it could not be deleted again. */
  | { key: 'leftover'; name: string };

export type AddServerOutcome =
  | { ok: true; created: AddServerResult }
  | {
      ok: false;
      fields?: Record<string, Issue>;
      message?: AddServerMessage;
      values: Record<string, string>;
    };

export interface AddServerDeps {
  /** The web database (typed through the auth core: only lib/repo touches it directly). */
  db: AuthRuntime['db'];
  user: { id: string; role?: string | null };
  /** The daemon's internal API, resolved only when a credential is created or removed. */
  api: () => Pick<InternalApiClient, 'createCredential' | 'deleteCredential'>;
  /** Instance setting `local_shell_visible` (the local kind also needs an admin). */
  localShellVisible: boolean;
  logger?: Pick<WebLogger, 'warn' | 'error'>;
}

/** The inputs of one section, without their prefix, as that section's own form posts them. */
function section(formData: FormData, prefix: string): FormData {
  const out = new FormData();
  for (const [key, value] of formData.entries()) {
    if (key.startsWith(prefix) && typeof value === 'string')
      out.append(key.slice(prefix.length), value);
  }
  return out;
}

const hostIssue = (key: string): HostIssue =>
  (HOST_ISSUES as readonly string[]).includes(key) ? (key as HostIssue) : 'invalid';
const profileIssue = (key: string): ProfileIssue =>
  (PROFILE_ISSUES as readonly string[]).includes(key) ? (key as ProfileIssue) : 'invalid';

/** The credential's name when none is typed: `<username>@<server name>`, cut to the limit. */
export function defaultCredentialName(username: string, serverName: string): string {
  return `${username}@${serverName}`.slice(0, CREDENTIAL_NAME_MAX);
}

/** A refused write inside the host/profile transaction (rolls the host back). */
class WriteRefused extends Error {
  readonly reason: 'host' | 'credential';

  constructor(reason: 'host' | 'credential') {
    super(`profile write refused: ${reason}`);
    this.reason = reason;
  }
}

async function removeCredential(deps: AddServerDeps, credentialId: string): Promise<boolean> {
  try {
    await deps.api().deleteCredential(credentialId, deps.user.id);
    return true;
  } catch (err) {
    deps.logger?.warn('add server: could not delete the credential created for a failed write', {
      credentialId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function addServerCore(
  deps: AddServerDeps,
  formData: FormData,
): Promise<AddServerOutcome> {
  const { db, user } = deps;
  const fields: Record<string, Issue> = {};
  const values: Record<string, string> = {};

  // ── 1. server ─────────────────────────────────────────────────────────────
  const hostMode = text(formData, 'host.mode') === 'existing' ? 'existing' : 'new';
  values['host.mode'] = hostMode;
  let existing: HostSummary | null = null;
  let hostInput: HostInput | null = null;
  let kind: HostKind = 'ssh';
  let serverName = '';
  if (hostMode === 'existing') {
    const id = text(formData, 'host.id').trim();
    values['host.id'] = id;
    existing = id ? getHost(db, user.id, id) : null;
    if (existing) {
      kind = existing.kind;
      serverName = existing.name;
    } else {
      fields['host.id'] = { scope: 'addServer', key: id ? 'hostMissing' : 'hostRequired' };
    }
  } else {
    const host = readHostForm(section(formData, 'host.'));
    for (const [key, value] of Object.entries(host.values)) values[`host.${key}`] = value;
    kind = host.values.kind === 'local' ? 'local' : 'ssh';
    serverName = host.values.name.trim();
    if (host.parsed.success) {
      hostInput = host.parsed.data;
      if (kind === 'local' && !localKindAvailability(deps, user.role).allowed) {
        fields['host.kind'] = { scope: 'host', key: 'kindLocal' };
      }
    } else {
      for (const [field, key] of Object.entries(issuesOf(host.parsed.error))) {
        fields[`host.${field}`] = { scope: 'host', key: hostIssue(key) };
      }
    }
  }

  // ── 2. sign-in: always a new connection profile ────────────────────────────
  const profileData = section(formData, 'profile.');
  const typedProfileName = text(profileData, 'name');
  const username = text(profileData, 'username').trim();
  // The profile name is optional and defaults to the user name (≤ 64 fits the name's 80).
  if (!typedProfileName.trim()) profileData.set('name', username);
  profileData.delete('credentialId');
  const profile = readProfileForm(profileData);
  for (const [key, value] of Object.entries(profile.values)) {
    if (key !== 'credentialId') values[`profile.${key}`] = value;
  }
  values['profile.name'] = typedProfileName;
  if (!profile.parsed.success) {
    for (const [field, key] of Object.entries(issuesOf(profile.parsed.error))) {
      // A blank name came from a blank user name, which carries its own error.
      if (field === 'name' && !typedProfileName.trim()) continue;
      fields[`profile.${field}`] = { scope: 'profile', key: profileIssue(key) };
    }
  } else if (profile.duplicate) {
    fields['profile.env'] = { scope: 'profile', key: profile.duplicate };
  }

  // ── 3. credential (a local shell signs in without one) ─────────────────────
  let choice: CredentialChoice | null = null;
  let credentialName = '';
  let savedCredentialId: string | null = null;
  let request: CreateCredentialInput | null = null;
  if (kind === 'ssh') {
    const raw = text(formData, 'credential.mode');
    choice = (CHOICES as readonly string[]).includes(raw) ? (raw as CredentialChoice) : 'generate';
    values['credential.mode'] = choice;
    if (choice === 'saved') {
      const id = text(formData, 'credential.id').trim();
      values['credential.id'] = id;
      const name = id ? getCredentialName(db, user.id, id) : null;
      if (name === null) {
        fields['credential.id'] = {
          scope: 'addServer',
          key: id ? 'credentialMissing' : 'credentialRequired',
        };
      } else {
        savedCredentialId = id;
        credentialName = name;
      }
    } else {
      const typedName = text(formData, 'credential.name').trim();
      values['credential.name'] = typedName;
      credentialName = typedName || defaultCredentialName(username, serverName);
      if (typedName.length > CREDENTIAL_NAME_MAX) {
        fields['credential.name'] = { scope: 'credential', key: 'nameLong' };
      }
      const base = { actingUserId: user.id, name: credentialName };
      if (choice === 'password') {
        const password = text(formData, 'credential.password');
        if (!password)
          fields['credential.password'] = { scope: 'credential', key: 'passwordRequired' };
        request = { ...base, kind: 'password', password };
      } else if (choice === 'private_key') {
        const privateKey = text(formData, 'credential.privateKey').trim();
        const passphrase = text(formData, 'credential.passphrase');
        if (!privateKey) {
          fields['credential.privateKey'] = { scope: 'credential', key: 'privateKeyRequired' };
        } else if (privateKey.length > PRIVATE_KEY_MAX) {
          fields['credential.privateKey'] = { scope: 'credential', key: 'privateKeyLong' };
        }
        request = {
          ...base,
          kind: 'private_key',
          privateKey: `${privateKey}\n`,
          ...(passphrase ? { passphrase } : {}),
        };
      } else {
        request = { ...base, kind: 'generate', algorithm: 'ed25519' };
      }
    }
  }

  if (Object.keys(fields).length > 0 || !profile.parsed.success) {
    return { ok: false, fields, values };
  }
  if (!existing && !hostInput) return { ok: false, message: { key: 'generic' }, values };

  const { env, ...rest } = profile.parsed.data;
  const profileInput: ProfileInput = {
    ...rest,
    credentialId: null,
    env: Object.fromEntries(env.map((pair) => [pair.key, pair.value])),
  };

  // ── write 1: the new credential, through the daemon ────────────────────────
  let created: CreateCredentialResult | null = null;
  if (request) {
    try {
      created = await deps.api().createCredential(request);
    } catch (err) {
      if (!isInternalApiError(err)) throw err;
      if (err.code === 'CREDENTIAL_INVALID') {
        return {
          ok: false,
          fields: { 'credential.privateKey': { scope: 'credential', key: 'privateKeyInvalid' } },
          values,
        };
      }
      return { ok: false, message: { key: serviceErrorKey(err) }, values };
    }
    if (request.kind === 'generate' && !created.publicKey) {
      const removed = await removeCredential(deps, created.credentialId);
      return {
        ok: false,
        message: removed ? { key: 'generic' } : { key: 'leftover', name: credentialName },
        values,
      };
    }
  }
  const credentialId = created?.credentialId ?? savedCredentialId;

  // ── write 2: host (when new) and profile, all or nothing ───────────────────
  let written: { hostId: string; profileId: string };
  try {
    written = db.$client.transaction(() => {
      const hostId = existing ? existing.id : createHost(db, user.id, hostInput as HostInput);
      // createProfile opens its own transaction; better-sqlite3 nests it as a savepoint.
      const result = createProfile(db, user.id, hostId, { ...profileInput, credentialId });
      if (result.outcome === 'not_found') throw new WriteRefused('host');
      if (result.outcome !== 'ok' || !result.id) throw new WriteRefused('credential');
      return { hostId, profileId: result.id };
    })();
  } catch (err) {
    if (!(err instanceof WriteRefused)) {
      deps.logger?.error('add server: writing the host and profile failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const removed = created ? await removeCredential(deps, created.credentialId) : true;
    const failedFields: Record<string, Issue> = {};
    if (err instanceof WriteRefused && err.reason === 'host' && existing) {
      failedFields['host.id'] = { scope: 'addServer', key: 'hostMissing' };
    } else if (err instanceof WriteRefused && err.reason === 'credential' && savedCredentialId) {
      failedFields['credential.id'] = { scope: 'addServer', key: 'credentialMissing' };
    }
    const hasFields = Object.keys(failedFields).length > 0;
    const message: AddServerMessage | undefined = !removed
      ? { key: 'leftover', name: credentialName }
      : hasFields
        ? undefined
        : { key: 'saveFailed' };
    return {
      ok: false,
      ...(hasFields ? { fields: failedFields } : {}),
      ...(message ? { message } : {}),
      values,
    };
  }

  const hostName = existing ? existing.name : (hostInput as HostInput).name;
  const address = existing
    ? kind === 'ssh'
      ? `${existing.hostname}:${existing.port}`
      : null
    : kind === 'ssh'
      ? `${(hostInput as HostInput).hostname}:${(hostInput as HostInput).port}`
      : null;
  return {
    ok: true,
    created: {
      hostId: written.hostId,
      hostName,
      hostCreated: !existing,
      kind,
      address,
      profileId: written.profileId,
      profileName: profileInput.name,
      username: profileInput.username,
      credential: choice
        ? {
            choice,
            name: credentialName,
            publicKey: request?.kind === 'generate' ? (created?.publicKey ?? null) : null,
            fingerprint: created?.fingerprint ?? null,
          }
        : null,
    },
  };
}
