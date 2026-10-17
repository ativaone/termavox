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
  issuesOf,
  readServerForm,
  SERVER_ISSUES,
  SERVER_NAME_MAX,
  text,
  toServerInput,
} from '../manage/forms.ts';
import { localKindAvailability } from '../manage/local-kind.ts';
import { type ServiceErrorKey, serviceErrorKey } from '../manage/service-errors.ts';
import { getCredentialName } from '../repo/credentials.ts';
import {
  type AuditMeta,
  createServer,
  getServer,
  type Server,
  type ServerKind,
} from '../repo/servers.ts';
import { formatTarget } from '../servers/target.ts';
import type { AddServerResult, CredentialChoice } from './add-server-states.ts';

/**
 * The work behind "Add server" (plan D-29), free of Next so T0 tests can drive it with a real
 * database and a fake internal API. One form, two sections, every input namespaced by its
 * section (`server.*`, `credential.*`); the server section is read with the same parser as the
 * server page.
 *
 * Order: validate both sections and return every field error at once (nothing written); create
 * a new credential through the daemon (the step most likely to fail, e.g. an unreadable key);
 * then insert the server. If the insert fails, the credential created a moment before is deleted
 * again. Secrets are never echoed in `values`.
 */

const CREDENTIAL_NAME_MAX = 120;
const PRIVATE_KEY_MAX = 32_768;
const CHOICES: readonly CredentialChoice[] = [
  'generate',
  'private_key',
  'password',
  'saved',
  'none',
];

type ServerIssue = (typeof SERVER_ISSUES)[number] | 'invalid' | 'kindLocal' | 'envDuplicate';
type CredentialIssue =
  | 'nameLong'
  | 'passwordRequired'
  | 'privateKeyRequired'
  | 'privateKeyLong'
  | 'privateKeyInvalid';
type AddServerIssue = 'credentialRequired' | 'credentialMissing';

/** A field error as a message key in the catalog of the section that owns the rule. */
export type Issue =
  | { scope: 'server'; key: ServerIssue }
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
  /** Request facts for the `server.create` audit row. */
  meta?: AuditMeta;
  logger?: Pick<WebLogger, 'warn' | 'error'>;
}

/** The inputs of one section, without their prefix, as the server page posts them. */
function section(formData: FormData, prefix: string): FormData {
  const out = new FormData();
  for (const [key, value] of formData.entries()) {
    if (key.startsWith(prefix) && typeof value === 'string')
      out.append(key.slice(prefix.length), value);
  }
  return out;
}

const serverIssue = (key: string): ServerIssue =>
  (SERVER_ISSUES as readonly string[]).includes(key) ? (key as ServerIssue) : 'invalid';

/** The credential's name when none is typed: `<username>@<server name>`, cut to the limit. */
export function defaultCredentialName(username: string, serverName: string): string {
  return `${username}@${serverName}`.slice(0, CREDENTIAL_NAME_MAX);
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
  const server = readServerForm(section(formData, 'server.'));
  for (const [key, value] of Object.entries(server.values)) values[`server.${key}`] = value;
  const kind: ServerKind = server.values.kind === 'local' ? 'local' : 'ssh';
  const serverName = server.values.name.trim();
  const username = server.values.username.trim();
  if (server.parsed.success) {
    if (kind === 'local' && !localKindAvailability(deps, user.role).allowed) {
      fields['server.kind'] = { scope: 'server', key: 'kindLocal' };
    }
    if (server.duplicate) fields['server.env'] = { scope: 'server', key: server.duplicate };
  } else {
    for (const [field, key] of Object.entries(issuesOf(server.parsed.error))) {
      fields[`server.${field}`] = { scope: 'server', key: serverIssue(key) };
    }
  }

  // ── 2. credential (a local shell signs in without one) ─────────────────────
  let choice: CredentialChoice | null = null;
  let credentialName: string | null = null;
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
    } else if (choice !== 'none') {
      const typedName = text(formData, 'credential.name').trim();
      values['credential.name'] = typedName;
      const name = typedName || defaultCredentialName(username, serverName);
      credentialName = name;
      if (typedName.length > CREDENTIAL_NAME_MAX) {
        fields['credential.name'] = { scope: 'credential', key: 'nameLong' };
      }
      const base = { actingUserId: user.id, name };
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

  if (Object.keys(fields).length > 0 || !server.parsed.success) {
    return { ok: false, fields, values };
  }
  const data = server.parsed.data;

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
        message: removed ? { key: 'generic' } : { key: 'leftover', name: request.name },
        values,
      };
    }
  }
  const credentialId = created?.credentialId ?? savedCredentialId;

  // ── write 2: the server (with its audit row) ───────────────────────────────
  let serverId: string | null = null;
  let failure: 'credential' | 'error' = 'error';
  try {
    const result = createServer(db, user.id, toServerInput(data, credentialId), deps.meta);
    if (result.outcome === 'ok') serverId = result.id;
    else failure = 'credential';
  } catch (err) {
    deps.logger?.error('add server: writing the server failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (serverId === null) {
    const removed = created ? await removeCredential(deps, created.credentialId) : true;
    if (!removed) {
      return { ok: false, message: { key: 'leftover', name: credentialName ?? '' }, values };
    }
    if (failure === 'credential' && savedCredentialId) {
      return {
        ok: false,
        fields: { 'credential.id': { scope: 'addServer', key: 'credentialMissing' } },
        values,
      };
    }
    return { ok: false, message: { key: 'saveFailed' }, values };
  }

  return {
    ok: true,
    created: {
      serverId,
      serverName: data.name,
      kind,
      target: data.kind === 'ssh' ? formatTarget(data.username, data.hostname, data.port) : null,
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

/** `copyName(name)` cut so it fits the name limit: the source name gives way, never the suffix. */
function fittedCopyName(name: string, copyName: (name: string) => string): string {
  const full = copyName(name);
  if (full.length <= SERVER_NAME_MAX) return full;
  const keep = Math.max(1, name.length - (full.length - SERVER_NAME_MAX) - 1);
  return copyName(`${name.slice(0, keep)}…`).slice(0, SERVER_NAME_MAX);
}

/**
 * "Duplicate" (plan D-29): the Add form's starting values from a server, every field copied, the
 * name with the localized copy suffix, and the credential section on "Use a saved credential"
 * with the same credential (or "None" when it has none). Reads only.
 */
export function prefillFrom(
  source: Server,
  copyName: (name: string) => string,
): Record<string, string> {
  return {
    'server.name': fittedCopyName(source.name, copyName),
    'server.kind': source.kind,
    'server.hostname': source.hostname ?? '',
    'server.port': source.port === null ? '22' : String(source.port),
    'server.username': source.username ?? '',
    'server.protectionMode': source.protectionMode,
    'server.startupCommand': source.startupCommand ?? '',
    'server.keepaliveIntervalS': String(source.keepaliveIntervalS),
    'server.autoReopen': source.autoReopen ? 'on' : '',
    'server.scrollbackLines': String(source.scrollbackLines),
    'server.env': JSON.stringify(
      Object.entries(source.env).map(([key, value]) => ({ key, value })),
    ),
    'credential.mode': source.credentialId ? 'saved' : 'none',
    'credential.id': source.credentialId ?? '',
  };
}

/**
 * The duplicate prefill for one of the user's servers, or null for a missing id or another
 * user's server (ownership is checked here, server-side, through the user-scoped read). Nothing
 * is written until the user saves the form.
 */
export function duplicatePrefill(
  db: AuthRuntime['db'],
  userId: string,
  serverId: string,
  copyName: (name: string) => string,
): Record<string, string> | null {
  const source = getServer(db, userId, serverId);
  return source ? prefillFrom(source, copyName) : null;
}
