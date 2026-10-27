import '../server-guard.ts';
import type { TermavoxDb } from '@termavox/db';
import {
  parseTerminalPreferences,
  type TerminalPreferences,
  TerminalPreferencesInput,
} from '../preferences/terminal.ts';
import { isTheme, type Theme } from '../preferences/theme.ts';

/**
 * The user's own `user_preferences` row (plan §9: web owns it), keyed by `user_id`: a user can
 * only ever read or write their own preferences.
 */

export function getTerminalPreferences(db: TermavoxDb, userId: string): TerminalPreferences {
  const row = db.$client
    .prepare('SELECT terminal_json FROM user_preferences WHERE user_id = ?')
    .get(userId) as { terminal_json: string } | undefined;
  return parseTerminalPreferences(row?.terminal_json);
}

/** Validates (zod) and stores the preferences; creates the row on first save. */
export function saveTerminalPreferences(
  db: TermavoxDb,
  userId: string,
  preferences: TerminalPreferences,
  now: number = Date.now(),
): void {
  const value = TerminalPreferencesInput.parse(preferences);
  db.$client
    .prepare(
      `INSERT INTO user_preferences (user_id, terminal_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET terminal_json = excluded.terminal_json,
                                          updated_at = excluded.updated_at`,
    )
    .run(userId, JSON.stringify(value), now);
}

/** The stored interface theme (plan D-55), or null without a row or with an unknown value. */
export function getTheme(db: TermavoxDb, userId: string): Theme | null {
  const row = db.$client
    .prepare('SELECT theme FROM user_preferences WHERE user_id = ?')
    .get(userId) as { theme: string } | undefined;
  return isTheme(row?.theme) ? row.theme : null;
}

/** Stores the interface theme; creates the row (default terminal preferences) on first save. */
export function saveTheme(
  db: TermavoxDb,
  userId: string,
  theme: Theme,
  now: number = Date.now(),
): void {
  if (!isTheme(theme)) throw new TypeError('Unknown theme');
  db.$client
    .prepare(
      `INSERT INTO user_preferences (user_id, theme, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, updated_at = excluded.updated_at`,
    )
    .run(userId, theme, now);
}
