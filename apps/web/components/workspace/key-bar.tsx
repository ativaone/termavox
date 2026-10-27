'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { TerminalKey } from '../../lib/workspace/keys.ts';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  PasteIcon,
} from '../icons/index.tsx';
import { cx } from '../ui/cx.ts';

const KEY_CLASSES =
  'inline-flex h-11 min-w-8 flex-1 select-none items-center justify-center gap-1 rounded-control px-0.5 ' +
  'font-semibold text-sm transition-colors duration-(--duration-step) ease-(--ease-out) ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus';
const KEY_RESTING = 'bg-surface-raised text-ink active:bg-surface-pressed';
const KEY_ARMED = 'bg-accent-fill text-on-accent-fill active:bg-accent-fill-strong';

function Key({
  label,
  onPress,
  pressed,
  children,
}: {
  label?: string;
  onPress?: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      // The terminal keeps the focus, so the soft keyboard stays up while keys are tapped.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
      className={cx(KEY_CLASSES, pressed ? KEY_ARMED : KEY_RESTING)}
    >
      {children}
    </button>
  );
}

/**
 * Phone extra-key bar (plan §11.2, D-17): Esc, Tab, sticky Ctrl and Alt, arrows, pipe and paste.
 * Ctrl and Alt are owned by the workspace (`ctrl` / `alt` and their change handlers) because they
 * also apply to the next key typed on the soft keyboard. Keys never take the focus from the
 * terminal; an armed modifier lights cyan.
 */
export function KeyBar({
  ctrl,
  alt,
  onCtrlChange,
  onAltChange,
  onKey,
  onPaste,
  className,
}: {
  ctrl: boolean;
  alt: boolean;
  onCtrlChange(armed: boolean): void;
  onAltChange(armed: boolean): void;
  onKey(key: TerminalKey, modifiers: { ctrl: boolean; alt: boolean }): void;
  onPaste(): void;
  className?: string;
}) {
  const t = useTranslations('workspace.keybar');
  const send = (key: TerminalKey) => () => {
    onKey(key, { ctrl, alt });
    onCtrlChange(false);
    onAltChange(false);
  };
  return (
    <fieldset
      className={cx(
        'm-0 flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-line border-0 border-t bg-ground-deep px-1.5 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]',
        className,
      )}
    >
      <legend className="sr-only">{t('label')}</legend>
      <Key onPress={send('Escape')}>{t('esc')}</Key>
      <Key onPress={send('Tab')}>{t('tab')}</Key>
      <Key pressed={ctrl} onPress={() => onCtrlChange(!ctrl)}>
        {t('ctrl')}
      </Key>
      <Key pressed={alt} onPress={() => onAltChange(!alt)}>
        {t('alt')}
      </Key>
      <Key label={t('left')} onPress={send('ArrowLeft')}>
        <ArrowLeftIcon size={18} />
      </Key>
      <Key label={t('up')} onPress={send('ArrowUp')}>
        <ArrowUpIcon size={18} />
      </Key>
      <Key label={t('down')} onPress={send('ArrowDown')}>
        <ArrowDownIcon size={18} />
      </Key>
      <Key label={t('right')} onPress={send('ArrowRight')}>
        <ArrowRightIcon size={18} />
      </Key>
      <Key label={t('pipe')} onPress={send('|')}>
        <span aria-hidden="true" className="font-mono text-base">
          |
        </span>
      </Key>
      <Key label={t('paste')} onPress={onPaste}>
        <PasteIcon size={18} />
      </Key>
    </fieldset>
  );
}
