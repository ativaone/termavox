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
/** The confirmation slips: room for End's tip, and for both buttons on one row. */
const CONFIRM_WIDTH = 320;

/**
 * A session row's actions: open in a new tab, split right or down (desktop), retry (disconnected
 * or reconnecting), reopen (ended), neither once its server was deleted, rename, and set apart at
 * the bottom terminate, or remove for an ended session (plan D-32). Both ask first, inside the
 * menu itself (a danger slip, no modal); terminate's slip also says that closing the tab or the
 * browser keeps the session. A native popover: it renders in the top layer, closes on Escape or
 * a click outside, and gives the focus back to its button.
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
  const [confirming, setConfirming] = useState<'terminate' | 'remove' | null>(null);
  const [pending, setPending] = useState<SessionActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const width = confirming ? CONFIRM_WIDTH : MENU_WIDTH;
  const menu = usePopoverMenu({
    width,
    align: 'end',
    onToggle: (open) => {
      if (!open) {
        setConfirming(null);
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
  // A session whose server was deleted never connects again: Terminate is all that is left.
  const reconnectable = !session.serverDeleted;
  if (reconnectable && (session.status === 'disconnected' || session.status === 'reconnecting')) {
    items.push({ kind: 'retry', label: t('retry') });
  }
  if (reconnectable && ended) items.push({ kind: 'reopen', label: t('reopen') });
  if (actions.rename) items.push({ kind: 'rename', label: t('rename') });
  const terminable = !ended;
  // The bottom, destructive action: terminate a live session, remove an ended one.
  const finalAction: Item = terminable
    ? { kind: 'terminate', label: t('terminate') }
    : { kind: 'remove', label: t('remove') };

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
      case 'remove':
        setConfirming(item.kind);
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
      <MenuPopover menu={menu} width={width}>
        {confirming ? (
          <fieldset
            aria-labelledby={`${menu.menuId}-question`}
            className={cx(DANGER_SLIP_CLASSES, 'm-0 min-w-0 rounded-none border-0')}
          >
            <p id={`${menu.menuId}-question`} className="text-pretty">
              {confirming === 'terminate'
                ? t('terminateQuestion', { label: session.label })
                : t('removeQuestion', { label: session.label })}
            </p>
            {/* Ending is rarely what someone who only wants to leave needs. */}
            {confirming === 'terminate' ? (
              <Notice tone="info" title={t('terminateTipTitle')}>
                {t('terminateTip')}
              </Notice>
            ) : null}
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="destructive"
                size="sm"
                isolated={false}
                loading={pending === confirming}
                onClick={() => void run(confirming)}
              >
                {confirming === 'terminate' ? t('terminateConfirm') : t('removeConfirm')}
              </Button>
              <Button data-cancel="" variant="quiet" size="sm" onClick={() => setConfirming(null)}>
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
              {items.length > 0 ? (
                // Deliberate space: terminate or remove never sits next to the routine actions.
                <MenuSeparator spaced />
              ) : null}
              <MenuItem
                tone="danger"
                disabled={pending !== null}
                onClick={() => choose(finalAction)}
              >
                {finalAction.label}
              </MenuItem>
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
