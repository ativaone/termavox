import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cx } from './cx.ts';

/**
 * A table inside a card: column labels small and muted, a hairline between rows, tabular
 * figures. Below 48rem every row becomes a block and each cell shows its own label, so nothing
 * scrolls sideways on a phone.
 */
export function DataTable({
  caption,
  head,
  children,
  className,
}: {
  /** Accessible name of the table (visually hidden). */
  caption: string;
  head: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <table className={cx('w-full border-collapse text-base text-ink tabular-nums', className)}>
      <caption className="sr-only">{caption}</caption>
      <thead className="max-md:sr-only">
        <tr className="border-line border-b">{head}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function Th({
  className,
  children,
  numeric = false,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cx(
        'px-3 py-2.5 align-bottom font-semibold text-ink-muted text-xs first:ps-5 last:pe-5 sm:first:ps-6 sm:last:pe-6',
        numeric ? 'text-end' : 'text-start',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function Tr({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <tr
      className={cx(
        'border-line border-t first:border-t-0 max-md:block max-md:px-5 max-md:py-3',
        'transition-colors duration-(--duration-step) ease-(--ease-out) md:hover:bg-surface',
        className,
      )}
    >
      {children}
    </tr>
  );
}

interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  /** Column label repeated inside the cell on phones (the header row is hidden there). */
  label?: string;
  /** The row's title cell: on phones it reads as the block heading, without a label. */
  primary?: boolean;
  /** A count or measure: right-aligned in its column on wide screens. */
  numeric?: boolean;
}

export function Td({
  label,
  primary = false,
  numeric = false,
  className,
  children,
  ...props
}: TdProps) {
  return (
    <td
      className={cx(
        'px-3 py-3 align-middle first:ps-5 last:pe-5 sm:first:ps-6 sm:last:pe-6',
        'max-md:flex max-md:min-w-0 max-md:items-baseline max-md:gap-2 max-md:px-0 max-md:py-0.5 max-md:first:ps-0 max-md:last:pe-0',
        primary && 'max-md:pb-1.5',
        numeric && 'md:text-end',
        className,
      )}
      {...props}
    >
      {label && !primary ? (
        <span className="shrink-0 text-ink-muted text-sm md:hidden">{label}</span>
      ) : null}
      {children}
    </td>
  );
}
