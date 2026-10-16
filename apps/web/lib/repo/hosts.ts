import '../server-guard.ts';
import type { TermdockDb } from '@termdock/db';

/** How many hosts the user owns (drives the first-run empty state). User-scoped by `user_id`. */
export function countHosts(db: TermdockDb, userId: string): number {
  const row = db.$client
    .prepare('SELECT COUNT(*) AS total FROM hosts WHERE user_id = ?')
    .get(userId) as {
    total: number;
  };
  return row.total;
}
