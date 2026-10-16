'use client';

import { useTranslations } from 'next-intl';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { SessionActionResult } from '../../lib/sessions/action-result.ts';
import type { BaySession } from '../../lib/sessions/types.ts';
import { MoreIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { Notice } from '../ui/notice.tsx';
import { Spinner } from '../ui/spinner.tsx';
import type { SessionActionKind } from './workspace-context.tsx';

export interface StripMenuActions {
  openInTab(): void;
  split(direction: 'row' | 'column'): void;
  run(kind: SessionActionKind): Promise<SessionActionResult>;
}

type Item =
  | { kind: 'tab' | 'right' | 'down'; label: string }
  | { kind: SessionActionKind; label: string };

const MENU_WIDTH = 240;
const GAP = 4;

/**
 * A strip's actions: open in a new tab, split right or down (desktop), retry (disconnected or
 * reconnecting), reopen (ended), and terminate, set apart at the bottom. Terminate asks first,
 * inside the menu itself (a danger slip, no modal). A native popover: it renders in the top
 * layer, closes on Escape or a click outside, and gives the focus back to its button.
 */
export function StripMenu({
  session,
  desktop,
  actions,
  openSignal,
}: {
  session: BaySession;
  desktop: boolean;
  actions: StripMenuActions;
  /** Bumped to open the menu from the strip's context menu. */
  openSignal: number;
}) {
  const t = useTranslations('workspace.menu');
  const buttonId = useId();
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<SessionActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const ended = session.status === 'ended';
  const items: Item[] = [];
  if (desktop) {
    items.push(
      { kind: 'tab', label: t('openInTab') },
      { kind: 'right', label: t('splitRight') },
      { kind: 'down', label: t('splitDown') },
    );
  }
  if (session.status === 'disconnected' || session.status === 'reconnecting') {
    items.push({ kind: 'retry', label: t('retry') });
  }
  if (ended) items.push({ kind: 'reopen', label: t('reopen') });
  const terminable = !ended;

  const show = () => popoverRef.current?.showPopover();
  const hide = () => {
    if (popoverRef.current?.matches(':popover-open')) popoverRef.current.hidePopover();
  };

  useEffect(() => {
    if (openSignal > 0) popoverRef.current?.showPopover();
  }, [openSignal]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const onToggle = (event: Event) => {
      const opening = (event as ToggleEvent).newState === 'open';
      setOpen(opening);
      if (!opening) {
        setConfirming(false);
        setError(null);
        // Back to the button, unless the focus already moved elsewhere on purpose.
        if (!document.activeElement || document.activeElement === document.body) {
          buttonRef.current?.focus();
        }
      }
    };
    popover.addEventListener('toggle', onToggle);
    return () => popover.removeEventListener('toggle', onToggle);
  }, []);

  // Place the menu under the button (or above it near the bottom of the window), again whenever
  // its content changes height (the confirmation slip, an error).
  // biome-ignore lint/correctness/useExhaustiveDependencies: confirming and error change the height
  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current?.getBoundingClientRect();
    const height = popoverRef.current?.offsetHeight ?? 0;
    if (!button) return;
    const left = Math.max(
      8,
      Math.min(button.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8),
    );
    const below = button.bottom + GAP;
    const top =
      below + height > window.innerHeight - 8 ? Math.max(8, button.top - GAP - height) : below;
    setPosition({ top, left });
  }, [open, confirming, error]);

  // Keyboard: the first item takes the focus; arrows, Home and End move it; Tab closes.
  useEffect(() => {
    if (!open) return;
    const target = confirming
      ? popoverRef.current?.querySelector<HTMLElement>('[data-cancel]')
      : popoverRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    target?.focus();
  }, [open, confirming]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      hide();
      return;
    }
    if (confirming) return;
    const entries = [
      ...(popoverRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    ];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (at + 1) % entries.length;
    else if (event.key === 'ArrowUp') next = (at - 1 + entries.length) % entries.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = entries.length - 1;
    else return;
    event.preventDefault();
    entries[next]?.focus();
  };

  const run = async (kind: SessionActionKind) => {
    setPending(kind);
    setError(null);
    try {
      const result = await actions.run(kind);
      if (result.ok) hide();
      else setError(result.message);
    } finally {
      setPending(null);
    }
  };

  const choose = (item: Item) => {
    switch (item.kind) {
      case 'tab':
        hide();
        actions.openInTab();
        return;
      case 'right':
      case 'down':
        hide();
        actions.split(item.kind === 'right' ? 'row' : 'column');
        return;
      case 'terminate':
        setConfirming(true);
        return;
      default:
        void run(item.kind);
    }
  };

  const itemClass = cx(
    'flex h-9 w-full items-center gap-2 px-3 text-start text-base text-ink',
    'transition-colors duration-(--duration-step) ease-linear hover:bg-quiet-hover',
    'focus-visible:bg-quiet-hover focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
    'disabled:cursor-not-allowed disabled:text-ink-faint',
  );

  return (
    <>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        aria-label={t('label', { label: session.label })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => (open ? hide() : show())}
        className={cx(
          'flex w-full items-center justify-center text-ink-muted',
          'transition-colors duration-(--duration-step) ease-linear hover:bg-quiet-hover hover:text-ink',
          'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
          open && 'bg-quiet-hover text-ink',
        )}
      >
        <MoreIcon size={16} />
      </button>
      <div
        ref={popoverRef}
        id={menuId}
        popover="auto"
        style={{
          width: MENU_WIDTH,
          inset: 'auto',
          margin: 0,
          top: position?.top ?? 0,
          left: position?.left ?? 0,
        }}
        className="surface-stock overflow-hidden rounded-panel bg-stock text-ink shadow-panel"
      >
        {confirming ? (
          <fieldset
            aria-labelledby={`${menuId}-question`}
            className="m-0 flex min-w-0 flex-col gap-3 border-0 bg-tint-danger px-3 py-3 text-base text-stock-ink"
          >
            <p id={`${menuId}-question`} className="text-pretty">
              {t('terminateQuestion', { label: session.label })}
            </p>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="destructive"
                size="sm"
                isolated={false}
                loading={pending === 'terminate'}
                onClick={() => void run('terminate')}
              >
                {t('terminateConfirm')}
              </Button>
              <Button data-cancel="" variant="quiet" size="sm" onClick={() => setConfirming(false)}>
                {t('cancel')}
              </Button>
            </div>
          </fieldset>
        ) : (
          <>
            <div
              role="menu"
              aria-labelledby={buttonId}
              onKeyDown={onKeyDown}
              className="flex flex-col py-1"
            >
              {items.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={pending !== null}
                  onClick={() => choose(item)}
                  className={itemClass}
                >
                  <span className="flex-1">{item.label}</span>
                  {pending === item.kind ? <Spinner size={14} /> : null}
                </button>
              ))}
              {terminable && items.length > 0 ? (
                // Deliberate space: terminate never sits next to the routine actions.
                <hr className="mt-2 mb-1 border-rule border-t" />
              ) : null}
              {terminable ? (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={pending !== null}
                  onClick={() => choose({ kind: 'terminate', label: t('terminate') })}
                  className={cx(itemClass, 'text-danger')}
                >
                  {t('terminate')}
                </button>
              ) : null}
            </div>
            {error ? (
              <div className="px-2 pb-2">
                <Notice tone="danger">{error}</Notice>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
