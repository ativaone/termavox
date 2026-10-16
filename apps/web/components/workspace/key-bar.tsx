'use client';

import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  PasteIcon,
} from '../icons/index.tsx';
import { cx } from '../ui/cx.ts';

export type TerminalKey =
  | 'Escape'
  | 'Tab'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | '|';

const KEY_CLASSES =
  'inline-flex h-11 min-w-9 flex-1 select-none items-center justify-center gap-1.5 rounded-control px-1 ' +
  'bg-board-3 font-semibold text-board-ink text-sm transition-colors duration-(--duration-step) ease-linear ' +
  'active:bg-board-rule focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-board';

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
      onClick={onPress}
      className={cx(KEY_CLASSES, pressed && 'bg-stock text-stock-ink active:bg-stock-pressed')}
    >
      {children}
    </button>
  );
}

/**
 * Phone extra-key bar (plan §11.2): Esc, Tab, sticky Ctrl, arrows, pipe and paste. Rendering and
 * the sticky Ctrl state only; the terminal client wires `onKey`/`onPaste` in the next workstream.
 */
export function KeyBar({
  onKey,
  onPaste,
  className,
}: {
  onKey?: (key: TerminalKey, modifiers: { ctrl: boolean }) => void;
  onPaste?: () => void;
  className?: string;
}) {
  const t = useTranslations('workspace.keybar');
  const [ctrl, setCtrl] = useState(false);
  const send = (key: TerminalKey) => () => {
    onKey?.(key, { ctrl });
    setCtrl(false);
  };
  return (
    <fieldset
      className={cx(
        'm-0 flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-0 bg-board-2 px-1.5 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]',
        className,
      )}
    >
      <legend className="sr-only">{t('label')}</legend>
      <Key onPress={send('Escape')}>{t('esc')}</Key>
      <Key onPress={send('Tab')}>{t('tab')}</Key>
      <Key pressed={ctrl} onPress={() => setCtrl((on) => !on)}>
        {t('ctrl')}
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
