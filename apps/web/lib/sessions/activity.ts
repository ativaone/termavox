import { SessionState, type SessionStatus, toSessionStatus } from '@termdock/protocol/client';

/**
 * How the activity log words a session's internal states (plan §8.1 /activity). Several
 * internal states share one public status ("Connecting…"), so a `state_changed` row names the
 * step as well: "Connecting… · Signing in".
 */
export const PHASE_KEYS = {
  verifying_host: 'checkingHostKey',
  authenticating: 'signingIn',
  probing: 'checkingHost',
  starting: 'startingShell',
  syncing: 'syncingScreen',
} as const satisfies Partial<Record<SessionState, string>>;
export type PhaseKey = (typeof PHASE_KEYS)[keyof typeof PHASE_KEYS];

/** An internal state (`verifying_host`, `ready`…) as the user-facing status it maps to. */
export function statusOf(state: unknown): SessionStatus | null {
  const parsed = SessionState.safeParse(state);
  // The log does not say whether the session had been ready before; "Connecting…" it is.
  return parsed.success ? toSessionStatus(parsed.data, false) : null;
}

/** The step an internal state stands for, or null (`new`, `connecting` and the rest). */
export function phaseOf(state: unknown): PhaseKey | null {
  const parsed = SessionState.safeParse(state);
  if (!parsed.success) return null;
  return (PHASE_KEYS as Partial<Record<SessionState, PhaseKey>>)[parsed.data] ?? null;
}

export interface StateChangeWords {
  status(status: SessionStatus): string;
  phase(phase: PhaseKey): string;
  transition(from: string, to: string): string;
  /** A failure or end reason in words, or null when the code is not one we word. */
  reason(code: unknown): string | null;
}

/**
 * A `state_changed` row's detail: the public status first, then the target's phase, then the
 * reason. A move between public statuses reads "from → to · phase"; a move inside one status
 * (verifying_host → authenticating) shows only the target: "Connecting… · Signing in".
 */
export function describeStateChange(
  detail: Record<string, unknown>,
  words: StateChangeWords,
): string {
  const to = statusOf(detail.to);
  if (!to) return '';
  const from = statusOf(detail.from);
  const target = words.status(to);
  const move = from && from !== to ? words.transition(words.status(from), target) : target;
  const phase = phaseOf(detail.to);
  return [move, phase ? words.phase(phase) : null, words.reason(detail.detail)]
    .filter(Boolean)
    .join(' · ');
}

export interface Run<T> {
  /** The first row of the run: the newest, since the log is listed newest first. */
  row: T;
  /** How many consecutive rows it stands for (1 when nothing was merged). */
  count: number;
}

/**
 * Display-only merge of consecutive rows with the same key (same session, event type and
 * summary text). Pagination stays on the stored rows; only what one page shows is merged.
 */
export function collapseRuns<T>(rows: readonly T[], keyOf: (row: T) => string): Run<T>[] {
  const runs: Run<T>[] = [];
  let lastKey: string | null = null;
  for (const row of rows) {
    const key = keyOf(row);
    const last = runs.at(-1);
    if (last && key === lastKey) last.count++;
    else runs.push({ row, count: 1 });
    lastKey = key;
  }
  return runs;
}
