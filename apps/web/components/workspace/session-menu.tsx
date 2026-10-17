'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { SessionActionResult } from '../../lib/sessions/action-result.ts';
import type { BaySession } from '../../lib/sessions/types.ts';
import { MoreIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { MenuItem, MenuPopover, MenuSeparator, usePopoverMenu } from '../ui/menu.tsx';
import { DANGER_SLIP_CLASSES, Notice } from '../ui/notice.tsx';
import { Spinner } from '../ui/spinner.tsx';
import type { SessionActionKind } from './workspace-context.tsx';

export interface SessionMenuActions {
  openInTab(): void;
  split(direction: 'row' | 'column'): void;
  /** Opens the rename dialog for this session (plan D-28). */
  rename?(): void;
  run(kind: SessionActionKind): Promise<SessionActionResult>;
}

type Item =
  | { kind: 'tab' | 'right' | 'down' | 'rename'; label: string }
  | { kind: SessionActionKind; label: string };

const MENU_WIDTH = 240;

/**
 * A session row's actions: open in a new tab, split right or down (desktop), retry (disconnected
 * or reconnecting), reopen (ended), rename, and terminate, set apart at the bottom. Terminate asks first,
 * inside the menu itself (a danger slip, no modal). A native popover: it renders in the top
 * layer, closes on Escape or a click outside, and gives the focus back to its button.
 */
export function SessionMenu({
  session,
  desktop,
  actions,
  openSignal,
}: {
  session: BaySession;
  desktop: boolean;
  actions: SessionMenuActions;
  /** Bumped to open the menu from the row's context menu. */
  openSignal: number;
}) {
  const t = useTranslations('workspace.menu');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<SessionActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menu = usePopoverMenu({
    width: MENU_WIDTH,
    align: 'end',
    onToggle: (open) => {
      if (!open) {
        setConfirming(false);
        setError(null);
      }
    },
  });

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
  if (actions.rename) items.push({ kind: 'rename', label: t('rename') });
  const terminable = !ended;

  const { show, relayout } = menu;
  useEffect(() => {
    if (openSignal > 0) show();
  }, [openSignal, show]);

  // The confirmation slip and an error change the height: place the menu again, and move the
  // focus to the slip's cancel control.
  // biome-ignore lint/correctness/useExhaustiveDependencies: confirming and error change the height
  useEffect(() => {
    relayout();
    if (confirming) {
      menu.popoverRef.current?.querySelector<HTMLElement>('[data-cancel]')?.focus();
    }
  }, [confirming, error, relayout]);

  const run = async (kind: SessionActionKind) => {
    setPending(kind);
    setError(null);
    try {
      const result = await actions.run(kind);
      if (result.ok) menu.hide();
      else setError(result.message);
    } finally {
      setPending(null);
    }
  };

  const choose = (item: Item) => {
    switch (item.kind) {
      case 'tab':
        menu.hide();
        actions.openInTab();
        return;
      case 'right':
      case 'down':
        menu.hide();
        actions.split(item.kind === 'right' ? 'row' : 'column');
        return;
      case 'rename':
        menu.hide();
        actions.rename?.();
        return;
      case 'terminate':
        setConfirming(true);
        return;
      default:
        void run(item.kind);
    }
  };

  return (
    <>
      <button
        ref={menu.anchorRef}
        id={menu.buttonId}
        type="button"
        aria-label={t('label', { label: session.label })}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.menuId}
        onClick={menu.toggle}
        className={cx(
          'flex size-7 items-center justify-center rounded-sm text-ink-muted',
          'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-pressed hover:text-ink',
          'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
          menu.open && 'bg-surface-pressed text-ink',
        )}
      >
        <MoreIcon size={16} />
      </button>
      <MenuPopover menu={menu} width={MENU_WIDTH}>
        {confirming ? (
          <fieldset
            aria-labelledby={`${menu.menuId}-question`}
            className={cx(DANGER_SLIP_CLASSES, 'm-0 min-w-0 rounded-none border-0')}
          >
            <p id={`${menu.menuId}-question`} className="text-pretty">
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
              aria-labelledby={menu.buttonId}
              onKeyDown={menu.onKeyDown}
              className="flex flex-col p-1"
            >
              {items.map((item) => (
                <MenuItem key={item.kind} disabled={pending !== null} onClick={() => choose(item)}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {pending === item.kind ? <Spinner size={14} /> : null}
                  </span>
                </MenuItem>
              ))}
              {terminable && items.length > 0 ? (
                // Deliberate space: terminate never sits next to the routine actions.
                <MenuSeparator spaced />
              ) : null}
              {terminable ? (
                <MenuItem
                  tone="danger"
                  disabled={pending !== null}
                  onClick={() => choose({ kind: 'terminate', label: t('terminate') })}
                >
                  {t('terminate')}
                </MenuItem>
              ) : null}
            </div>
            {error ? (
              <div className="px-2 pb-2">
                <Notice tone="danger">{error}</Notice>
              </div>
            ) : null}
          </>
        )}
      </MenuPopover>
    </>
  );
}
