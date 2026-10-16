import type { Protection, SessionStatus } from '@termdock/protocol/client';

/** One strip in the bay: what the signed-in user needs to read a session at a glance. */
export interface BaySession {
  id: string;
  label: string;
  status: SessionStatus;
  /** Effective protection; null until the session has started once. */
  protection: Protection | null;
  /** Remote login name (`target_username`). */
  user: string;
  /** The host's name, or the snapshotted hostname when the host was deleted. */
  host: string;
  createdAt: number;
  endedAt: number | null;
}

/** What a tab or a pane caption shows of a session: its label and its state edge. */
export type SessionLabel = Pick<BaySession, 'label' | 'status'>;

export interface BayData {
  /** Every non-ended session plus the latest ended ones (see ENDED_SHOWN). */
  sessions: BaySession[];
  /** How many ended sessions exist in total (the bay lists at most ENDED_SHOWN). */
  endedTotal: number;
}
