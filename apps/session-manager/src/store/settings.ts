import { uuidv7 } from '@termdock/shared';
import type { FileSettings } from '../files/settings.ts';
import type { BatchedWriter } from './batched-writer.ts';
import { execute, getRow, parseJson, type Sqlite } from './sqlite.ts';

/**
 * `instance_settings` access. The daemon writes only `installation_id` and `vault_key_check`
 * (plan §9); every other key is web's and is only read here.
 */
export const SETTING_INSTALLATION_ID = 'installation_id';
export const SETTING_VAULT_KEY_CHECK = 'vault_key_check';
export const SETTING_MAX_RUNNING_SESSIONS = 'max_running_sessions_per_user';
export const DEFAULT_MAX_RUNNING_SESSIONS = 50;
export const SETTING_FILE_TRANSFER_ENABLED = 'file_transfer_enabled';
export const SETTING_FILE_AUDIT_ENABLED = 'file_audit_enabled';

/** Parsed `value_json` of a setting, or undefined when absent or not valid JSON. */
export function readSetting(sqlite: Sqlite, key: string): unknown {
  const row = getRow<{ value_json: string }>(
    sqlite,
    'SELECT value_json FROM instance_settings WHERE key = ?',
    key,
  );
  return parseJson(row?.value_json);
}

/** Inserts a daemon-owned setting unless it already exists (never overwrites). */
export function insertSettingIfAbsent(sqlite: Sqlite, key: string, value: unknown): void {
  execute(
    sqlite,
    'INSERT INTO instance_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING',
    key,
    JSON.stringify(value),
    Date.now(),
  );
}

/** Boot step 1 (plan §5.8): the installation id (a JSON string), created once. */
export function ensureInstallationId(writer: BatchedWriter): Promise<string> {
  return writer.run('installation_id', (sqlite) => {
    const existing = readSetting(sqlite, SETTING_INSTALLATION_ID);
    if (typeof existing === 'string' && existing.length > 0) return existing;
    if (existing !== undefined) throw new Error('instance_settings.installation_id is invalid');
    const id = uuidv7();
    insertSettingIfAbsent(sqlite, SETTING_INSTALLATION_ID, id);
    return id;
  });
}

/** Per-user running-session cap (web-owned setting; default 50). */
export function maxRunningSessions(sqlite: Sqlite): number {
  const value = readSetting(sqlite, SETTING_MAX_RUNNING_SESSIONS);
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_MAX_RUNNING_SESSIONS;
}

/**
 * The file panel's settings (plan §5.12; web-owned): transfer is on unless stored as `false`, the
 * audit only when stored as `true`.
 */
export function readFileSettings(sqlite: Sqlite): FileSettings {
  return {
    transferEnabled: readSetting(sqlite, SETTING_FILE_TRANSFER_ENABLED) !== false,
    auditEnabled: readSetting(sqlite, SETTING_FILE_AUDIT_ENABLED) === true,
  };
}
