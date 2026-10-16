import type { SessionStatus } from '@termdock/protocol/client';
import type { BaySession } from './types.ts';

/** The bay lists at most this many ended sessions (plan §11.1). */
export const ENDED_SHOWN = 20;

/**
 * Lane order, most urgent first: sessions waiting on the user, then failures, then recovery in
 * progress, then healthy, then history. Only non-empty lanes are shown.
 */
export const LANE_ORDER = [
  'action_required',
  'disconnected',
  'reconnecting',
  'restoring',
  'connecting',
  'connected',
  'ended',
] as const satisfies readonly SessionStatus[];

export interface Lane {
  status: SessionStatus;
  sessions: BaySession[];
}

/** Groups sessions into non-empty lanes in LANE_ORDER, keeping the input order inside a lane. */
export function groupIntoLanes(sessions: readonly BaySession[]): Lane[] {
  const byStatus = new Map<SessionStatus, BaySession[]>();
  for (const session of sessions) {
    const lane = byStatus.get(session.status);
    if (lane) lane.push(session);
    else byStatus.set(session.status, [session]);
  }
  return LANE_ORDER.flatMap((status) => {
    const laneSessions = byStatus.get(status);
    return laneSessions ? [{ status, sessions: laneSessions }] : [];
  });
}

/** True when at least one session sits in a different lane than before (drives the slide). */
export function laneChanged(before: readonly BaySession[], after: readonly BaySession[]): boolean {
  const previous = new Map(before.map((s) => [s.id, s.status]));
  return after.some((s) => previous.has(s.id) && previous.get(s.id) !== s.status);
}
