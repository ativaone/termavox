import { z } from 'zod';
import type { FormState } from '../actions/form-state.ts';

/**
 * Form parsing for the management surfaces (servers, credentials, settings). Schemas
 * produce field-level issue keys that the Server Actions localize; submitted secrets are never
 * echoed back (`values` only ever carries non-secret fields).
 */

export function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

export function checked(formData: FormData, name: string): boolean {
  return formData.get(name) === 'on';
}

/** An integer field; NaN when empty or not a whole number. */
export function integer(formData: FormData, name: string): number {
  const raw = text(formData, name).trim();
  return /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

/** Field name → issue key for the first failing check of each field. */
export type FieldIssues = Record<string, string>;

export function issuesOf(error: z.ZodError): FieldIssues {
  const issues: FieldIssues = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? 'form');
    if (!(field in issues)) issues[field] = issue.message;
  }
  return issues;
}

/** Field issues as localized messages; a check without its own key reads as `invalid`. */
export function localizeIssues<K extends string>(
  error: z.ZodError,
  known: readonly K[],
  translate: (key: K | 'invalid') => string,
): Record<string, string> {
  const set = new Set<string>(known);
  return Object.fromEntries(
    Object.entries(issuesOf(error)).map(([field, key]) => [
      field,
      translate(set.has(key) ? (key as K) : 'invalid'),
    ]),
  );
}

export const SERVER_ISSUES = [
  'nameRequired',
  'nameLong',
  'kind',
  'hostnameRequired',
  'hostname',
  'port',
  'usernameRequired',
  'username',
  'protection',
  'startupLong',
  'startupControl',
  'envKey',
  'envValue',
  'envValueControl',
  'envCount',
  'keepalive',
  'scrollback',
] as const;

// ── servers (plan D-29) ─────────────────────────────────────────────────────

export const HOSTNAME_PATTERN = /^[A-Za-z0-9._:[\]-]+$/;
export const SCROLLBACK_MIN = 1_000;
export const SCROLLBACK_MAX = 10_000;
export const KEEPALIVE_MIN = 5;
export const KEEPALIVE_MAX = 300;
export const ENV_MAX = 32;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SERVER_NAME_MAX = 80;

/**
 * C0 control characters other than TAB (CR, LF, NUL, ESC…). The startup command and the
 * environment reach the server inside one quoted shell line, which cannot carry them.
 */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 && code !== 0x09) return true;
  }
  return false;
}

const singleLine = (value: string): boolean => !hasControlChars(value);

const serverName = z.string().trim().min(1, 'nameRequired').max(SERVER_NAME_MAX, 'nameLong');

/** How sessions from a server behave (the "Advanced" options). */
const ServerOptionsShape = {
  protectionMode: z.enum(['auto', 'off'], { message: 'protection' }),
  startupCommand: z
    .string()
    .max(1_000, 'startupLong')
    .refine(singleLine, 'startupControl')
    .nullable(),
  env: z
    .array(
      z.object({
        key: z.string().regex(ENV_KEY_PATTERN, 'envKey'),
        value: z.string().max(1_000, 'envValue').refine(singleLine, 'envValueControl'),
      }),
    )
    .max(ENV_MAX, 'envCount'),
  keepaliveIntervalS: z
    .number({ message: 'keepalive' })
    .int('keepalive')
    .min(KEEPALIVE_MIN, 'keepalive')
    .max(KEEPALIVE_MAX, 'keepalive'),
  autoReopen: z.boolean(),
  scrollbackLines: z
    .number({ message: 'scrollback' })
    .int('scrollback')
    .min(SCROLLBACK_MIN, 'scrollback')
    .max(SCROLLBACK_MAX, 'scrollback'),
};

/** An SSH server: everything an `ssh -p port user@host` command line holds, plus the options. */
export const SshServerForm = z.object({
  name: serverName,
  kind: z.literal('ssh'),
  hostname: z
    .string()
    .trim()
    .min(1, 'hostnameRequired')
    .max(253, 'hostname')
    .regex(HOSTNAME_PATTERN, 'hostname'),
  port: z.number({ message: 'port' }).int('port').min(1, 'port').max(65_535, 'port'),
  username: z
    .string()
    .trim()
    .min(1, 'usernameRequired')
    .max(64, 'username')
    .regex(/^\S+$/, 'username'),
  ...ServerOptionsShape,
});

/** A local (direct-mode) server: no address, user name or credential. */
export const LocalServerForm = z.object({
  name: serverName,
  kind: z.literal('local'),
  hostname: z.null(),
  port: z.null(),
  username: z.null(),
  ...ServerOptionsShape,
});

export type ServerFormData = z.infer<typeof SshServerForm> | z.infer<typeof LocalServerForm>;

/**
 * Reads the server fields (unprefixed) as both the Add form's server section and the server
 * page post them. `kind` is `local` only when posted as such. The credential is read by the
 * caller (a choice on the Add form, a select on the server page). `values` echoes every input
 * (none is secret); `env` as JSON rows.
 */
export function readServerForm(formData: FormData) {
  const kind = text(formData, 'kind') === 'local' ? 'local' : 'ssh';
  const keys = formData.getAll('envKey').map((v) => (typeof v === 'string' ? v.trim() : ''));
  const vals = formData.getAll('envValue').map((v) => (typeof v === 'string' ? v : ''));
  const env = keys
    .map((key, i) => ({ key, value: vals[i] ?? '' }))
    .filter((pair) => pair.key !== '' || pair.value !== '');
  const startup = text(formData, 'startupCommand').trim();
  const options = {
    protectionMode: text(formData, 'protectionMode') === 'off' ? 'off' : 'auto',
    startupCommand: startup || null,
    env,
    keepaliveIntervalS: integer(formData, 'keepaliveIntervalS'),
    autoReopen: checked(formData, 'autoReopen'),
    scrollbackLines: integer(formData, 'scrollbackLines'),
  };
  const parsed =
    kind === 'local'
      ? LocalServerForm.safeParse({
          name: text(formData, 'name'),
          kind,
          hostname: null,
          port: null,
          username: null,
          ...options,
        })
      : SshServerForm.safeParse({
          name: text(formData, 'name'),
          kind,
          hostname: text(formData, 'hostname'),
          port: integer(formData, 'port'),
          username: text(formData, 'username'),
          ...options,
        });
  const duplicate: 'envDuplicate' | null =
    parsed.success && new Set(env.map((p) => p.key)).size !== env.length ? 'envDuplicate' : null;
  return {
    parsed,
    duplicate,
    values: {
      name: text(formData, 'name'),
      kind,
      hostname: text(formData, 'hostname'),
      port: text(formData, 'port'),
      username: text(formData, 'username'),
      protectionMode: options.protectionMode,
      startupCommand: startup,
      keepaliveIntervalS: text(formData, 'keepaliveIntervalS'),
      autoReopen: options.autoReopen ? 'on' : '',
      scrollbackLines: text(formData, 'scrollbackLines'),
      env: JSON.stringify(env),
    },
  };
}

/** The parsed form as a repository input (env rows → object) with the chosen credential. */
export function toServerInput(data: ServerFormData, credentialId: string | null) {
  const { env, ...rest } = data;
  return {
    ...rest,
    credentialId: data.kind === 'local' ? null : credentialId,
    env: Object.fromEntries(env.map((pair) => [pair.key, pair.value])),
  };
}

/** Result of a form action on the management pages. */
export interface ManageState extends FormState {
  /** Success message, already localized. */
  notice?: string;
  /** Bumped on each success so client forms can reset. */
  savedAt?: number;
}

export const EMPTY_MANAGE: ManageState = {};
