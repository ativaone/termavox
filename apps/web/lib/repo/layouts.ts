import '../server-guard.ts';
import type { TermavoxDb } from '@termavox/db';
import { EMPTY_LAYOUT, WorkspaceLayout } from '@termavox/protocol';

/**
 * The user's own `workspace_layouts` row (plan §9: web owns it), keyed by `user_id`: a user can
 * only ever read or replace their own layout. Writes are compare-and-set on `version`
 * (optimistic concurrency, plan §8.2): the caller states the version it last saw.
 */

export interface StoredLayout {
  layout: WorkspaceLayout;
  /** 0 while the user has never saved a layout. */
  version: number;
}

export type SaveLayoutResult = { ok: true; version: number } | { ok: false; version: number };

/** The stored layout, or the empty layout at version 0. Unreadable JSON reads as empty. */
export function getLayout(db: TermavoxDb, userId: string): StoredLayout {
  const row = db.$client
    .prepare('SELECT version, layout_json FROM workspace_layouts WHERE user_id = ?')
    .get(userId) as { version: number; layout_json: string } | undefined;
  if (!row) return { layout: EMPTY_LAYOUT, version: 0 };
  let value: unknown = null;
  try {
    value = JSON.parse(row.layout_json);
  } catch {
    value = null;
  }
  const parsed = WorkspaceLayout.safeParse(value);
  return { layout: parsed.success ? parsed.data : EMPTY_LAYOUT, version: row.version };
}

/**
 * Replaces the layout when `expectedVersion` is the stored version (0 = no row yet) and returns
 * the new version; otherwise returns the current version untouched. Validated with zod.
 */
export function saveLayout(
  db: TermavoxDb,
  userId: string,
  layout: WorkspaceLayout,
  expectedVersion: number,
  now: number = Date.now(),
): SaveLayoutResult {
  const json = JSON.stringify(WorkspaceLayout.parse(layout));
  const sqlite = db.$client;
  const write = sqlite.transaction((): SaveLayoutResult => {
    const row = sqlite
      .prepare('SELECT version FROM workspace_layouts WHERE user_id = ?')
      .get(userId) as { version: number } | undefined;
    const current = row?.version ?? 0;
    if (current !== expectedVersion) return { ok: false, version: current };
    const next = current + 1;
    if (row) {
      sqlite
        .prepare(
          `UPDATE workspace_layouts SET version = ?, layout_json = ?, updated_at = ?
            WHERE user_id = ? AND version = ?`,
        )
        .run(next, json, now, userId, current);
    } else {
      sqlite
        .prepare(
          'INSERT INTO workspace_layouts (user_id, version, layout_json, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(userId, next, json, now);
    }
    return { ok: true, version: next };
  });
  return write.immediate();
}
