import { formatSize } from '../files/format.ts';

/** Detail fields with a label in `admin.audit.details.key`. */
export const DETAIL_KEYS = [
  'stage',
  'reason',
  'method',
  'otherSessionsRevoked',
  'role',
  'scope',
  'terminated',
  'lockedForS',
  'unknownUser',
  'username',
  'totpRequired',
  'temporaryPassword',
  'name',
  'kind',
  'keyType',
  'fingerprint',
  'previousFingerprint',
  'source',
  'previousLabel',
  'label',
  'hostname',
  'port',
  'path',
  'size',
  'bytes',
  'completed',
  'paths',
  'removed',
] as const;
export type DetailKey = (typeof DETAIL_KEYS)[number];
export const isDetailKey = (key: string): key is DetailKey =>
  (DETAIL_KEYS as readonly string[]).includes(key);

/** Enumerated detail values with a word in `admin.audit.details.value.<key>`. */
const DETAIL_VALUES = {
  stage: ['password', 'totp', 'backup_code'],
  method: ['password', 'totp', 'backup_code', 'trusted_device'],
  reason: ['invalid', 'disabled', 'ban'],
  scope: ['auth_sessions', 'websockets'],
  source: ['pending', 'pasted', 'host_test'],
  role: ['user', 'admin'],
  kind: ['password', 'private_key', 'generate', 'ssh', 'local'],
} as const;
type DetailValueKey = {
  [K in keyof typeof DETAIL_VALUES]: `details.value.${K}.${(typeof DETAIL_VALUES)[K][number]}`;
}[keyof typeof DETAIL_VALUES];
const valueKey = (key: string, value: unknown): DetailValueKey | null => {
  if (!Object.hasOwn(DETAIL_VALUES, key)) return null;
  const known = DETAIL_VALUES[key as keyof typeof DETAIL_VALUES] as readonly unknown[];
  return known.includes(value) ? (`details.value.${key}.${value}` as DetailValueKey) : null;
};

/** Detail fields that count bytes: a file's size, the bytes a download sent (`file.download`). */
const BYTE_KEYS: ReadonlySet<string> = new Set(['size', 'bytes']);

/** The `admin.audit` messages a detail value can read as. */
export type DetailValueWords = (
  key: 'details.yes' | 'details.no' | 'details.seconds' | DetailValueKey,
  values?: { count: number },
) => string;

/**
 * A detail value in words: yes/no (a download's `completed` too), known enum words, seconds,
 * byte counts as sizes; machine values as-is.
 */
export function auditDetailValue(
  key: string,
  value: string | number | boolean,
  t: DetailValueWords,
  locale: string,
): string {
  if (typeof value === 'boolean') return value ? t('details.yes') : t('details.no');
  if (key === 'lockedForS' && typeof value === 'number') {
    return t('details.seconds', { count: value });
  }
  if (BYTE_KEYS.has(key) && typeof value === 'number') return formatSize(value, locale);
  const word = valueKey(key, value);
  return word ? t(word) : String(value).slice(0, 80);
}
