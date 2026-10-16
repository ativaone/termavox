import { cx } from './cx.ts';

/**
 * The Termdock mark: a blank flight strip (stock, edge cell, two hairline cell rules) beside the
 * name in the strip voice. No state colour: the mark is not a session.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5 text-board-ink', className)}>
      <svg
        viewBox="0 0 28 16"
        width={28}
        height={16}
        aria-hidden="true"
        focusable="false"
        className="shrink-0"
      >
        <rect x="0" y="0" width="28" height="16" rx="1.5" fill="var(--color-stock)" />
        <rect x="0" y="0" width="4" height="16" rx="1" fill="var(--color-board-rule-strong)" />
        <rect x="7" y="4" width="9" height="2.5" fill="var(--color-stock-ink)" />
        <rect x="7" y="9.5" width="6" height="1.5" fill="var(--color-stock-ink-muted)" />
        <path d="M19.5 0v16M24 0v16" stroke="var(--color-stock-rule-strong)" strokeWidth="1" />
      </svg>
      <span className="font-bold font-strip-wide text-sm">Termdock</span>
    </span>
  );
}
