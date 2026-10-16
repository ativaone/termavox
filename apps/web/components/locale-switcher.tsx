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
 * JavaScript). Each language is named in itself.
 */
export function LocaleSwitcher({
  locale,
  hideLabel = false,
  fill = false,
  className,
}: {
  locale: Locale;
  hideLabel?: boolean;
  /** Stretch the select to the container's width. */
  fill?: boolean;
  className?: string;
}) {
  const t = useTranslations('common.locale');
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();
  return (
    <form ref={formRef} action={setLocale} className={cx('flex items-center gap-2', className)}>
      <label
        htmlFor={id}
        className={cx('flex items-center gap-1.5 text-ink-muted text-sm', hideLabel && 'sr-only')}
      >
        <GlobeIcon size={16} />
        {t('label')}
      </label>
      <span className={fill ? 'min-w-0 flex-1' : 'w-44'}>
        <NativeSelect
          key={locale}
          id={id}
          name="locale"
          compact
          defaultValue={locale}
          lang={locale}
          options={LOCALES.map((value) => ({ value, label: t(value) }))}
          onChange={() => formRef.current?.requestSubmit()}
        />
      </span>
      <noscript>
        <button type="submit" className="text-ink text-sm underline">
          {t('apply')}
        </button>
      </noscript>
    </form>
  );
}
