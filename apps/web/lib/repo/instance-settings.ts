import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';

/**
 * Instance settings web owns (plan §9): `require_totp`, `max_running_sessions_per_user` and
 * `local_shell_visible`. Values are JSON (`value_json`), read the same way by the daemon. Writes
 * are admin actions; the caller (lib/admin) checks the role and audits the change.
 */

export interface InstanceSettings {
  requireTotp: boolean;
  maxRunningSessionsPerUser: number;
  /** Direct-mode visibility; effective only when the daemon runs with local shells enabled. */
  localShellVisible: boolean;
}

export const SETTING_KEYS = {
  requireTotp: 'require_totp',
  maxRunningSessionsPerUser: 'max_running_sessions_per_user',
  localShellVisible: 'local_shell_visible',
} as const satisfies Record<keyof InstanceSettings, string>;

export const DEFAULT_MAX_RUNNING_SESSIONS = 50;

function readJson(db: TermdockDb, key: string): unknown {
  const row = db.$client
    .prepare('SELECT value_json FROM instance_settings WHERE key = ?')
    .get(key) as { value_json: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json) as unknown;
  } catch {
    return undefined;
  }
}

export function getInstanceSettings(db: TermdockDb): InstanceSettings {
  const max = readJson(db, SETTING_KEYS.maxRunningSessionsPerUser);
  return {
    requireTotp: readJson(db, SETTING_KEYS.requireTotp) === true,
    maxRunningSessionsPerUser:
      typeof max === 'number' && Number.isInteger(max) && max > 0
        ? max
        : DEFAULT_MAX_RUNNING_SESSIONS,
    localShellVisible: readJson(db, SETTING_KEYS.localShellVisible) === true,
  };
}

export function setInstanceSetting(
  db: TermdockDb,
  key: (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS],
  value: boolean | number,
  now: number = Date.now(),
): void {
  db.$client
    .prepare(
      `INSERT INTO instance_settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), now);
}
