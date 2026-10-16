import { z } from 'zod';
import type { FormState } from '../actions/form-state.ts';

/**
 * Form parsing for the management surfaces (hosts, profiles, credentials, settings). Schemas
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

export const HOST_ISSUES = [
  'nameRequired',
  'nameLong',
  'kind',
  'hostnameRequired',
  'hostname',
  'port',
] as const;

export const PROFILE_ISSUES = [
  'nameRequired',
  'nameLong',
  'usernameRequired',
  'username',
  'protection',
  'startupLong',
  'envKey',
  'envValue',
  'envCount',
  'keepalive',
  'scrollback',
] as const;

// ── hosts ───────────────────────────────────────────────────────────────────

export const HOSTNAME_PATTERN = /^[A-Za-z0-9._:[\]-]+$/;

export const HostForm = z.object({
  name: z.string().trim().min(1, 'nameRequired').max(80, 'nameLong'),
  kind: z.enum(['ssh', 'local'], { message: 'kind' }),
  hostname: z
    .string()
    .trim()
    .min(1, 'hostnameRequired')
    .max(253, 'hostname')
    .regex(HOSTNAME_PATTERN, 'hostname'),
  port: z.number({ message: 'port' }).int('port').min(1, 'port').max(65_535, 'port'),
});
export type HostForm = z.infer<typeof HostForm>;

export function readHostForm(formData: FormData) {
  const kind = text(formData, 'kind') === 'local' ? 'local' : 'ssh';
  // A local (direct-mode) host has no network address; the columns still need values.
  const raw =
    kind === 'local'
      ? { name: text(formData, 'name'), kind, hostname: 'localhost', port: 22 }
      : {
          name: text(formData, 'name'),
          kind,
          hostname: text(formData, 'hostname'),
          port: integer(formData, 'port'),
        };
  return {
    parsed: HostForm.safeParse(raw),
    values: {
      name: text(formData, 'name'),
      kind,
      hostname: text(formData, 'hostname'),
      port: text(formData, 'port'),
    },
  };
}

// ── profiles ────────────────────────────────────────────────────────────────

export const SCROLLBACK_MIN = 1_000;
export const SCROLLBACK_MAX = 10_000;
export const KEEPALIVE_MIN = 5;
export const KEEPALIVE_MAX = 300;
export const ENV_MAX = 32;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const ProfileForm = z.object({
  name: z.string().trim().min(1, 'nameRequired').max(80, 'nameLong'),
  username: z
    .string()
    .trim()
    .min(1, 'usernameRequired')
    .max(64, 'username')
    .regex(/^\S+$/, 'username'),
  credentialId: z.string().max(64).nullable(),
  protectionMode: z.enum(['auto', 'off'], { message: 'protection' }),
  startupCommand: z.string().max(1_000, 'startupLong').nullable(),
  env: z
    .array(
      z.object({
        key: z.string().regex(ENV_KEY_PATTERN, 'envKey'),
        value: z.string().max(1_000, 'envValue'),
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
});

export function readProfileForm(formData: FormData) {
  const keys = formData.getAll('envKey').map((v) => (typeof v === 'string' ? v.trim() : ''));
  const vals = formData.getAll('envValue').map((v) => (typeof v === 'string' ? v : ''));
  const env = keys
    .map((key, i) => ({ key, value: vals[i] ?? '' }))
    .filter((pair) => pair.key !== '' || pair.value !== '');
  const credentialId = text(formData, 'credentialId').trim();
  const startup = text(formData, 'startupCommand').trim();
  const raw = {
    name: text(formData, 'name'),
    username: text(formData, 'username'),
    credentialId: credentialId || null,
    protectionMode: text(formData, 'protectionMode') === 'off' ? 'off' : 'auto',
    startupCommand: startup || null,
    env,
    keepaliveIntervalS: integer(formData, 'keepaliveIntervalS'),
    autoReopen: checked(formData, 'autoReopen'),
    scrollbackLines: integer(formData, 'scrollbackLines'),
  };
  const parsed = ProfileForm.safeParse(raw);
  const duplicate: 'envDuplicate' | null =
    parsed.success && new Set(env.map((p) => p.key)).size !== env.length ? 'envDuplicate' : null;
  return {
    parsed,
    duplicate,
    values: {
      name: raw.name,
      username: raw.username,
      credentialId,
      protectionMode: raw.protectionMode,
      startupCommand: startup,
      keepaliveIntervalS: text(formData, 'keepaliveIntervalS'),
      autoReopen: raw.autoReopen ? 'on' : '',
      scrollbackLines: text(formData, 'scrollbackLines'),
      env: JSON.stringify(env),
    },
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
