import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export type TagTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONE: Record<TagTone, string> = {
  success: 'bg-success-soft text-state-connected',
  warning: 'bg-warning-soft text-state-reconnecting',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-accent',
  neutral: 'bg-surface-raised text-ink-muted',
};

/**
 * A short sentence-case pill for the state of a record that is not a session (host key Trusted /
 * Pending / Revoked, account Active / Disabled, roles). Feedback tones only: the state lamps
 * belong to sessions, and the word always carries the meaning.
 */
export function Tag({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: TagTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-pill px-2 font-semibold text-xs',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
