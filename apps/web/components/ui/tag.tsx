import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export type TagTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONE: Record<TagTone, string> = {
  success: 'bg-tint-success text-stock-ink',
  warning: 'bg-tint-warning text-stock-ink',
  danger: 'bg-tint-danger text-stock-ink',
  info: 'bg-tint-info text-stock-ink',
  neutral: 'border border-rule-strong text-ink-muted',
};

/**
 * A short sentence-case label on stock for the state of a record that is not a session (host key
 * Trusted / Pending / Revoked, account Active / Disabled, roles). Feedback tints only: the six
 * state colours belong to sessions (State-Only Rule), and the word always carries the meaning.
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
        'inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-[3px] px-1.5 font-semibold text-xs',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
