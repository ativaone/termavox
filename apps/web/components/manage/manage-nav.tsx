'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cx } from '../ui/cx.ts';
import { NavRow } from '../ui/nav-row.tsx';

export interface NavItem {
  href: string;
  label: string;
  icon?: ReactNode;
  /** Path prefix that marks the item current (defaults to href). */
  match?: string;
}

function isCurrent(pathname: string, item: NavItem): boolean {
  const prefix = item.match ?? item.href;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The management pages' sidebar navigation: icon and label rows, the current one lit. */
export function ManageNav({ items, label }: { items: NavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.href}>
            <NavRow href={item.href} icon={item.icon} current={isCurrent(pathname, item)}>
              {item.label}
            </NavRow>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The phone version: a sideways-scrolling row of links under the top bar. */
export function ManageNavRow({ items, label }: { items: NavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={label}
      className="overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)] [scrollbar-width:none]"
    >
      <ul className="flex items-center gap-1 px-2 pb-2 pe-10">
        {items.map((item) => {
          const current = isCurrent(pathname, item);
          return (
            <li key={item.href} className="flex shrink-0">
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={cx(
                  'flex h-8 items-center whitespace-nowrap rounded-pill px-3 font-medium text-sm',
                  'transition-colors duration-(--duration-step) ease-(--ease-out)',
                  'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
                  current
                    ? 'bg-accent-soft text-ink shadow-[inset_0_0_0_1px_var(--color-accent-ring)]'
                    : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
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
 * drawn under the page heading: the current one carries the cyan underline.
 */
export function SubNav({ items, label }: { items: NavItem[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="border-line border-b">
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
                  'text-ink-muted transition-colors duration-(--duration-step) ease-(--ease-out) hover:text-ink',
                  'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
                  current && 'border-b-accent text-ink',
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
