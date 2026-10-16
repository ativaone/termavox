import type { SessionSummary } from '@termdock/protocol/client';
import { ENDED_SHOWN } from './lanes.ts';
import type { BayData, BaySession } from './types.ts';

/**
 * The bay from the live `sessions.list` (every session the user ever had, newest first): the
 * same shape and order as the server-rendered bay (lib/repo/sessions.ts), so switching from the
 * first paint to live data moves nothing: non-ended sessions oldest first, then the latest
 * ENDED_SHOWN ended ones, newest first.
 */

export function toBaySession(summary: SessionSummary): BaySession {
  return {
    id: summary.id,
    label: summary.label,
    status: summary.status,
    protection: summary.protection,
    user: summary.username,
    host: summary.hostName,
    createdAt: summary.createdAt,
    endedAt: summary.endedAt,
  };
}

const byId = (a: SessionSummary, b: SessionSummary): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function toBayData(summaries: readonly SessionSummary[]): BayData {
  const live = summaries
    .filter((s) => s.status !== 'ended')
    .sort((a, b) => a.createdAt - b.createdAt || byId(a, b));
  const ended = summaries
    .filter((s) => s.status === 'ended')
    .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt) || byId(a, b));
  return {
    sessions: [...live, ...ended.slice(0, ENDED_SHOWN)].map(toBaySession),
    endedTotal: ended.length,
  };
}
