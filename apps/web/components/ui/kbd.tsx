import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * A keyboard key cap. `muted` reads on any surface; `inherit` takes the colour of the control it
 * sits in (a key hint inside a primary button).
 */
export function Kbd({
  children,
  tone = 'muted',
  className,
}: {
  children: ReactNode;
  tone?: 'muted' | 'inherit';
  className?: string;
}) {
  return (
    <kbd
      className={cx(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-[3px] border px-1',
        'font-sans font-semibold text-2xs tabular-nums',
        tone === 'muted' ? 'border-rule text-ink-muted' : 'border-current/30 text-current/75',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
