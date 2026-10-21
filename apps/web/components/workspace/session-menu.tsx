'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { SessionActionResult } from '../../lib/sessions/action-result.ts';
import type { BaySession } from '../../lib/sessions/types.ts';
import { MoreIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import {
  MenuCheckboxItem,
  MenuItem,
  MenuPopover,
  MenuSeparator,
  usePopoverMenu,
} from '../ui/menu.tsx';
import { DANGER_SLIP_CLASSES, Notice } from '../ui/notice.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { useSetSessionNotify } from './hooks.ts';
import type { SessionActionKind } from './workspace-context.tsx';

/** What the browser allows: its notification permission, or no Notification API at all. */
type Permission = NotificationPermission | 'unsupported';

function currentPermission(): Permission {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

/**
 * Asks the browser for permission. Call it synchronously inside the click (before any await, or
 * the browser drops the user's gesture and never shows its prompt). Older browsers answer through
 * a callback and return nothing: the outcome is read then; a throw counts as not asked.
 */
function askPermission(): Promise<Permission> {
  try {
    return Promise.resolve(Notification.requestPermission()).then(
      (answer): Permission => answer ?? Notification.permission,
      (): Permission => 'default',
    );
  } catch {
    return Promise.resolve('default');
  }
}

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
 * or reconnecting), reopen (ended), neither once its server was deleted, rename, the desktop
 * notifications check box (desktop, sessions that have not ended), and set apart at the bottom
 * terminate, or remove for an ended session (plan D-32). Both ask first, inside the menu itself
 * (a danger slip, no modal); terminate's slip also says that closing the tab or the browser keeps
 * the session. A native popover: it renders in the top layer, closes on Escape or a click
 * outside, and gives the focus back to its button.
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
  const tw = useTranslations('workspace');
  const [confirming, setConfirming] = useState<'terminate' | 'remove' | null>(null);
  const [pending, setPending] = useState<SessionActionKind | 'notify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Why the browser will not show this session's notifications (blocked, or no API).
  const [blocked, setBlocked] = useState<string | null>(null);
  // On for the session, but this browser was never asked (they were turned on in another one).
  const [askHere, setAskHere] = useState(false);
  const setNotify = useSetSessionNotify();
  const ended = session.status === 'ended';
  const notifiable = desktop && !ended;
  const blockedText = (permission: Permission): string | null =>
    permission === 'unsupported'
      ? tw('notify.unsupported')
      : permission === 'denied'
        ? tw('notify.blocked')
        : null;
  const width = confirming ? CONFIRM_WIDTH : MENU_WIDTH;
  const menu = usePopoverMenu({
    width,
    align: 'end',
    onToggle: (open) => {
      if (!open) {
        setConfirming(null);
        setError(null);
        setBlocked(null);
        setAskHere(false);
      } else if (notifiable && session.notify) {
        // On, but this browser blocks them or was never asked: say so where they are turned on.
        const permission = currentPermission();
        setBlocked(blockedText(permission));
        setAskHere(permission === 'default');
      }
    },
  });

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

  // The confirmation slip, an error and the blocked notice change the height: place the menu
  // again, and move the focus to the slip's cancel control.
  // biome-ignore lint/correctness/useExhaustiveDependencies: confirming, error, blocked and askHere change the height
  useEffect(() => {
    relayout();
    if (confirming) {
      menu.popoverRef.current?.querySelector<HTMLElement>('[data-cancel]')?.focus();
    }
  }, [confirming, error, blocked, askHere, relayout]);

  /**
   * The desktop notifications check box. Turning it on first asks the browser for permission when
   * it has not been asked yet, synchronously inside the click (before any await, or the browser
   * drops the user's gesture and never shows its prompt). The flag is saved whatever the answer:
   * it is the owner's choice for the session, in every browser; a browser that blocks them, or
   * has none, gets a notice saying so. The menu stays open while there is something to say.
   */
  const toggleNotify = () => {
    const on = !session.notify;
    const current = currentPermission();
    void saveNotify(on, on && current === 'default' ? askPermission() : current);
  };

  /** "Allow in this browser": asks here for a session whose notifications are already on. */
  const allowHere = () => {
    void askPermission().then((permission) => {
      setAskHere(permission === 'default');
      const notice = blockedText(permission);
      if (notice) setBlocked(notice);
      else if (permission === 'granted') menu.hide();
    });
  };

  const saveNotify = async (on: boolean, asked: Permission | Promise<Permission>) => {
    setPending('notify');
    setError(null);
    setBlocked(null);
    setAskHere(false);
    try {
      const result = await setNotify(session.id, on);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const notice = on ? blockedText(await asked) : null;
      if (notice) setBlocked(notice);
      else menu.hide();
    } catch {
      setError(tw('notice.actionFailed'));
    } finally {
      setPending(null);
    }
  };

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
              {notifiable ? (
                // A setting of the session, not an action: its own group under the actions.
                <>
                  {items.length > 0 ? <MenuSeparator /> : null}
                  <MenuCheckboxItem
                    checked={session.notify}
                    busy={pending === 'notify'}
                    disabled={pending !== null}
                    onClick={toggleNotify}
                  >
                    {tw('notify.menuItem')}
                  </MenuCheckboxItem>
                  {askHere && session.notify ? (
                    <MenuItem disabled={pending !== null} onClick={allowHere}>
                      {tw('notify.allowHere')}
                    </MenuItem>
                  ) : null}
                </>
              ) : null}
              {items.length > 0 || notifiable ? (
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
            ) : blocked ? (
              <div className="px-2 pb-2">
                <Notice tone="warning">{blocked}</Notice>
              </div>
            ) : null}
          </>
        )}
      </MenuPopover>
    </>
  );
}
