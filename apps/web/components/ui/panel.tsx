import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * A card: the translucent light fill with its 1 px line and 16 px corners (forms, in-pane
 * overlays, empty states, tables). `floating` adds the card shadow for a card that sits over
 * something else (an overlay inside a pane); `solid` makes it opaque, for anything that floats
 * over a live terminal.
 */
export function Panel({
  as: Tag = 'section',
  floating = false,
  solid = false,
  className,
  children,
  ...props
}: {
  as?: 'section' | 'div' | 'article';
  floating?: boolean;
  solid?: boolean;
  className?: string;
  children: ReactNode;
  'aria-labelledby'?: string;
  'aria-label'?: string;
}) {
  return (
    <Tag
      className={cx(
        solid ? 'card-solid' : 'card',
        'text-ink',
        floating && 'shadow-card',
        className,
      )}
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
  /** Draws the hairline above this section. */
  ruled?: boolean;
}) {
  return (
    <div className={cx('px-5 py-5 sm:px-6', ruled && 'border-line border-t', className)}>
      {children}
    </div>
  );
}
