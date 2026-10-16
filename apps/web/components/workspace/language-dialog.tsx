'use client';

import { useTranslations } from 'next-intl';
import { type RefObject, useId, useState } from 'react';
import { LOCALES, type Locale } from '../../i18n/locales.ts';
import { setLocale } from '../../lib/actions/locale.ts';
import { Button } from '../ui/button.tsx';
import { choiceCardClasses, radioClasses } from '../ui/radio.ts';
import { SubmitButton } from '../ui/submit-button.tsx';

/**
 * The language picker behind the account menu's "Language…" item (plan D-28): a native modal
 * dialog, so changing a rare setting never takes room in the menu itself. Each language is named
 * in itself; Apply re-renders the page in the chosen one. The account settings page keeps the
 * same choice as a plain form.
 */
export function LanguageDialog({
  dialogRef,
  locale,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  locale: Locale;
}) {
  const t = useTranslations('common.locale');
  const ta = useTranslations('workspace.account');
  const ts = useTranslations('settings.account.language');
  const titleId = useId();
  const [chosen, setChosen] = useState<Locale>(locale);

  const apply = async (formData: FormData) => {
    await setLocale(formData);
    dialogRef.current?.close();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => setChosen(locale)}
      className="card-solid m-auto w-[min(26rem,calc(100vw-2rem))] p-0 text-ink shadow-float backdrop:bg-ground-deep/70"
    >
      <form action={apply} className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="font-semibold text-ink text-md">
            {t('label')}
          </h2>
          <p className="text-ink-muted text-sm">{ts('intro')}</p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{t('label')}</legend>
          {LOCALES.map((value) => (
            <label
              key={value}
              className={choiceCardClasses(chosen === value, 'items-center gap-3 px-3 py-2.5')}
            >
              <input
                type="radio"
                name="locale"
                value={value}
                checked={chosen === value}
                onChange={() => setChosen(value)}
                className={radioClasses()}
              />
              <span lang={value} className="text-base text-ink">
                {t(value)}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton disabled={chosen === locale}>{t('apply')}</SubmitButton>
          <Button variant="secondary" onClick={() => dialogRef.current?.close()}>
            {ta('cancel')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
