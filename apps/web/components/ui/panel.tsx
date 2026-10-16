import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * A sheet of buff stock on the board (forms, in-pane overlays, empty states). Elevation is the
 * panel shadow alone; sections inside are divided by hairline cell rules, like a strip.
 */
export function Panel({
  as: Tag = 'section',
  className,
  children,
  ...props
}: {
  as?: 'section' | 'div' | 'article';
  className?: string;
  children: ReactNode;
  'aria-labelledby'?: string;
  'aria-label'?: string;
}) {
  return (
    <Tag
      className={cx('surface-stock rounded-panel bg-surface text-ink shadow-panel', className)}
      {...props}
    >
      {children}
    </Tag>
  );
}

export function PanelSection({
  className,
  children,
  ruled = false,
}: {
  className?: string;
  children: ReactNode;
  /** Draws the hairline cell rule above this section. */
  ruled?: boolean;
}) {
  return (
    <div className={cx('px-5 py-5 sm:px-6', ruled && 'border-rule border-t', className)}>
      {children}
    </div>
  );
}
