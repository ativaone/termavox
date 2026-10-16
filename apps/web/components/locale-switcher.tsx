'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef } from 'react';
import { LOCALES, type Locale } from '../i18n/locales.ts';
import { setLocale } from '../lib/actions/locale.ts';
import { GlobeIcon } from './icons/index.tsx';
import { cx } from './ui/cx.ts';
import { NativeSelect } from './ui/select.tsx';

/**
 * Language picker: a native select that submits on change (a plain Apply button without
 * JavaScript). Each language is named in itself. Signed-in pages reach the language through
 * the account menu; this control serves the account settings page and, as `discreet`, the
 * corner of the auth pages.
 */
export function LocaleSwitcher({
  locale,
  hideLabel = false,
  fill = false,
  discreet = false,
  className,
}: {
  locale: Locale;
  hideLabel?: boolean;
  /** Stretch the select to the container's width. */
  fill?: boolean;
  /** A small quiet control for a page corner (auth pages). */
  discreet?: boolean;
  className?: string;
}) {
  const t = useTranslations('common.locale');
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();
  const options = LOCALES.map((value) => ({ value, label: t(value) }));
  return (
    <form ref={formRef} action={setLocale} className={cx('flex items-center gap-2', className)}>
      <label
        htmlFor={id}
        className={cx(
          'flex items-center gap-1.5 text-ink-muted text-sm',
          (hideLabel || discreet) && 'sr-only',
        )}
      >
        <GlobeIcon size={16} />
        {t('label')}
      </label>
      {discreet ? (
        <span className="relative inline-flex items-center">
          <GlobeIcon
            size={15}
            className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
          />
          <NativeSelect
            key={locale}
            id={id}
            name="locale"
            compact
            defaultValue={locale}
            lang={locale}
            options={options}
            onChange={() => formRef.current?.requestSubmit()}
            className="border-transparent bg-transparent ps-8 text-ink-muted hover:border-line hover:bg-surface-raised hover:text-ink"
          />
        </span>
      ) : (
        <span className={fill ? 'min-w-0 flex-1' : 'w-48'}>
          <NativeSelect
            key={locale}
            id={id}
            name="locale"
            compact
            defaultValue={locale}
            lang={locale}
            options={options}
            onChange={() => formRef.current?.requestSubmit()}
          />
        </span>
      )}
      <noscript>
        <button type="submit" className="text-ink text-sm underline">
          {t('apply')}
        </button>
      </noscript>
    </form>
  );
}
