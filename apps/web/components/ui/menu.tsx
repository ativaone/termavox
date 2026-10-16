'use client';

import type Link from 'next/link';
import {
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cx } from './cx.ts';

const GAP = 6;
const MARGIN = 8;

export interface PopoverMenu {
  /** Put on the control that opens the menu. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  /** Put on the popover element. */
  popoverRef: RefObject<HTMLDivElement | null>;
  buttonId: string;
  menuId: string;
  open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
  /** Where the popover sits (viewport coordinates), once measured. */
  position: { top: number; left: number } | null;
  /** Arrow keys, Home, End move the focus between items; Tab closes. */
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
  /** Re-measures the popover (after its content changed height). */
  relayout(): void;
}

const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

/**
 * A native popover (top layer, light dismiss, Escape) placed beside its anchor: below it, or above
 * when there is no room, aligned to the anchor's start or end edge. The first item takes the focus
 * on open; closing gives it back to the anchor unless the focus already moved on purpose.
 */
export function usePopoverMenu({
  width,
  align = 'end',
  onToggle,
}: {
  width: number;
  align?: 'start' | 'end';
  onToggle?: (open: boolean) => void;
}): PopoverMenu {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonId = useId();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [layoutKey, setLayoutKey] = useState(0);
  const onToggleRef = useRef(onToggle);
  useEffect(() => {
    onToggleRef.current = onToggle;
  }, [onToggle]);

  const show = useCallback(() => popoverRef.current?.showPopover(), []);
  const hide = useCallback(() => {
    if (popoverRef.current?.matches(':popover-open')) popoverRef.current.hidePopover();
  }, []);
  const toggle = useCallback(() => (open ? hide() : show()), [open, hide, show]);
  const relayout = useCallback(() => setLayoutKey((k) => k + 1), []);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const handle = (event: Event) => {
      const opening = (event as ToggleEvent).newState === 'open';
      setOpen(opening);
      onToggleRef.current?.(opening);
      if (!opening && (!document.activeElement || document.activeElement === document.body)) {
        anchorRef.current?.focus();
      }
    };
    popover.addEventListener('toggle', handle);
    return () => popover.removeEventListener('toggle', handle);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutKey re-measures after a content change
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current?.getBoundingClientRect();
    const height = popoverRef.current?.offsetHeight ?? 0;
    if (!anchor) return;
    const wanted = align === 'end' ? anchor.right - width : anchor.left;
    const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - width - MARGIN));
    const below = anchor.bottom + GAP;
    const top =
      below + height > window.innerHeight - MARGIN
        ? Math.max(MARGIN, anchor.top - GAP - height)
        : below;
    setPosition({ top, left });
  }, [open, width, align, layoutKey]);

  useEffect(() => {
    if (!open) return;
    popoverRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
  }, [open]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Tab') {
        hide();
        return;
      }
      const entries = [...(popoverRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])];
      if (entries.length === 0) return;
      const at = entries.indexOf(document.activeElement as HTMLElement);
      let next = -1;
      if (event.key === 'ArrowDown') next = (at + 1) % entries.length;
      else if (event.key === 'ArrowUp') next = (at - 1 + entries.length) % entries.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = entries.length - 1;
      else return;
      event.preventDefault();
      entries[next]?.focus();
    },
    [hide],
  );

  return {
    anchorRef,
    popoverRef,
    buttonId,
    menuId,
    open,
    show,
    hide,
    toggle,
    position,
    onKeyDown,
    relayout,
  };
}

/** The floating card of a menu: opaque, lined, with the float shadow; `width` in CSS px. */
export function MenuPopover({
  menu,
  width,
  className,
  children,
}: {
  menu: PopoverMenu;
  width: number;
  className?: string;
  children: ReactNode;
}) {
  const style: CSSProperties = {
    width,
    inset: 'auto',
    margin: 0,
    top: menu.position?.top ?? 0,
    left: menu.position?.left ?? 0,
  };
  return (
    <div
      ref={menu.popoverRef}
      id={menu.menuId}
      popover="auto"
      style={style}
      className={cx('card-solid overflow-hidden p-0 text-ink shadow-float', className)}
    >
      {children}
    </div>
  );
}

export const MENU_ITEM_CLASSES =
  'flex h-9 w-full items-center gap-2.5 rounded-sm px-2.5 text-start text-base text-ink ' +
  'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-raised ' +
  'focus-visible:bg-surface-raised focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2 ' +
  'disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent';

export function MenuItem({
  icon,
  tone = 'default',
  className,
  children,
  ...props
}: ComponentProps<'button'> & { icon?: ReactNode; tone?: 'default' | 'danger' }) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={cx(MENU_ITEM_CLASSES, tone === 'danger' && 'text-danger', className)}
      {...props}
    >
      {icon ? (
        <span className="flex w-4 shrink-0 justify-center text-ink-muted">{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function MenuLink({
  icon,
  className,
  children,
  Component,
  ...props
}: ComponentProps<typeof Link> & { icon?: ReactNode; Component: typeof Link }) {
  return (
    <Component
      role="menuitem"
      tabIndex={-1}
      className={cx(MENU_ITEM_CLASSES, className)}
      {...props}
    >
      {icon ? (
        <span className="flex w-4 shrink-0 justify-center text-ink-muted">{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Component>
  );
}

/** A group heading inside a menu (not focusable). */
export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pt-2 pb-1 font-semibold text-ink-muted text-xs" role="presentation">
      {children}
    </p>
  );
}

export function MenuSeparator({ spaced = false }: { spaced?: boolean }) {
  return <hr className={cx('mx-1 border-line border-t', spaced ? 'my-2' : 'my-1')} />;
}
