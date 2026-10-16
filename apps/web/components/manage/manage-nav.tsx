'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '../ui/cx.ts';

export interface NavItem {
  href: string;
  label: string;
  /** Path prefix that marks the item current (defaults to href). */
  match?: string;
}

function isCurrent(pathname: string, item: NavItem): boolean {
  const prefix = item.match ?? item.href;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The management pages' top navigation on the slate bar: muted links, the current one in board
 * ink over a 2 px buff rule (the board's "you are here", never a state colour).
 */
export function ManageNav({
  items,
  label,
  className,
}: {
  items: NavItem[];
  label: string;
  className?: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className={className}>
      <ul className="flex h-full items-stretch gap-1">
        {items.map((item) => {
          const current = isCurrent(pathname, item);
          return (
            <li key={item.href} className="flex">
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={cx(
                  'flex items-center whitespace-nowrap border-transparent border-y-2 px-3 font-medium text-sm',
                  'text-board-ink-muted transition-colors duration-(--duration-step) ease-linear hover:text-board-ink',
                  'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
                  current && 'border-b-stock text-board-ink',
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Section tabs inside a page (Settings: Account / Terminal; Admin: Users / Settings / Audit),
 * drawn on the board under the page heading.
 */
export function SubNav({ items, label }: { items: NavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="border-board-rule border-b">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {items.map((item) => {
          const current = isCurrent(pathname, item);
          return (
            <li key={item.href} className="flex">
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={cx(
                  'flex h-10 items-center whitespace-nowrap border-transparent border-b-2 px-3 font-medium text-base',
                  'text-board-ink-muted transition-colors duration-(--duration-step) ease-linear hover:text-board-ink',
                  'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
                  current && 'border-b-stock text-board-ink',
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
