import type { Protection, SessionStatus } from '@termavox/protocol/client';

/** One strip in the bay: what the signed-in user needs to read a session at a glance. */
export interface BaySession {
  id: string;
  label: string;
  /** The owner turned on desktop notifications for its bell (stored on the session). */
  notify: boolean;
  status: SessionStatus;
  /** Effective protection; null until the session has started once. */
  protection: Protection | null;
  /** `local` for a direct-mode shell (no address); the target below is then unused. */
  kind: 'ssh' | 'local';
  /** Snapshotted at creation: the user name, hostname and port the session connects to. */
  username: string;
  hostname: string;
  port: number;
  /** Its server was deleted (plan D-29): it never connects again, so no Retry or Reopen. */
  serverDeleted: boolean;
  createdAt: number;
  endedAt: number | null;
  /** How many notes it has (plan D-58). */
  noteCount: number;
}

/** What a tab or a pane caption shows of a session: its label and its state edge. */
export type SessionLabel = Pick<BaySession, 'label' | 'status'>;

export interface BayData {
  /**
   * Every non-ended session, the latest ENDED_SHOWN ended ones and any older ended one that has
   * notes, so a note never becomes unreachable.
   */
  sessions: BaySession[];
  /** How many ended sessions exist in total, listed or not. */
  endedTotal: number;
  /** Session id → how many notes: every session of the user that has any. */
  noteCounts: Record<string, number>;
}
