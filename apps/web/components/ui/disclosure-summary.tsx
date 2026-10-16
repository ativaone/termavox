import type { ReactNode } from 'react';
import { ChevronRightIcon } from '../icons/index.tsx';
import { cx } from './cx.ts';

/**
 * The summary of a native disclosure, drawn like the Ended lane: the browser's marker is hidden
 * and a chevron turns a quarter when it opens. The parent `<details>` carries `group/disclosure`.
 */
export function DisclosureSummary({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <summary
      className={cx(
        'flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-control [&::-webkit-details-marker]:hidden',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        className,
      )}
    >
      <ChevronRightIcon
        size={14}
        className="shrink-0 text-ink-muted transition-transform duration-(--duration-move) ease-out group-open/disclosure:rotate-90"
      />
      {children}
    </summary>
  );
}
