import type { SessionSummary } from '@termavox/protocol/client';
import { ENDED_SHOWN } from './lanes.ts';
import type { BayData, BaySession, SessionLabel } from './types.ts';

/**
 * The bay from the live `sessions.list` (every session the user ever had, newest first): the
 * same shape and order as the server-rendered bay (lib/repo/sessions.ts), so switching from the
 * first paint to live data moves nothing: non-ended sessions oldest first, then the latest
 * ENDED_SHOWN ended ones, newest first.
 */

/** A live entry may carry the progress of a retry round (plan D-31, `session.status`). */
type LiveSummary = SessionSummary & { attempt?: number | null; retryUntil?: number | null };

export function toBaySession(summary: LiveSummary): BaySession {
  // Between the attempts of a retry round the row stays in Reconnecting instead of jumping to
  // Connecting and back at every attempt.
  const retrying = (summary.attempt ?? null) !== null || (summary.retryUntil ?? null) !== null;
  const attempting = summary.status === 'connecting' || summary.status === 'restoring';
  return {
    id: summary.id,
    label: summary.label,
    notify: summary.notify,
    status: retrying && attempting ? 'reconnecting' : summary.status,
    protection: summary.protection,
    kind: summary.kind,
    username: summary.username,
    hostname: summary.hostname,
    port: summary.port,
    serverDeleted: summary.serverId === null,
    createdAt: summary.createdAt,
    endedAt: summary.endedAt,
  };
}

const byId = (a: SessionSummary, b: SessionSummary): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function toBayData(summaries: readonly LiveSummary[]): BayData {
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

/**
 * Label and status per session for the tab bar and the pane captions. Until the live session
 * list arrives, and for as long as the WebSocket cannot connect, they come from the
 * server-rendered bay summaries (the bay's own strips show the same), not placeholders; once
 * the list has arrived, from the live entries only.
 */
export function sessionLabels(
  live: ReadonlyMap<string, SessionLabel>,
  liveLoaded: boolean,
  server: readonly BaySession[],
): ReadonlyMap<string, SessionLabel> {
  if (liveLoaded) return live;
  const labels = new Map<string, SessionLabel>();
  for (const session of server) {
    labels.set(session.id, { label: session.label, status: session.status });
  }
  for (const [id, session] of live) labels.set(id, session);
  return labels;
}
