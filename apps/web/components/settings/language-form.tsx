'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { LOCALES, type Locale } from '../../i18n/locales.ts';
import { setLocale } from '../../lib/actions/locale.ts';
import { choiceCardClasses, radioClasses } from '../ui/radio.ts';
import { SubmitButton } from '../ui/submit-button.tsx';
import { useKeepChoicesOnReset } from '../ui/use-keep-choices.ts';

/**
 * The language on Settings → Language (plan D-60): the languages as choice cards, each named in
 * itself, and Apply, which re-renders the page in the chosen one (the cookie and the account's
 * `user.locale`, `setLocale`).
 */
export function LanguageForm({ locale }: { locale: Locale }) {
  const t = useTranslations('common.locale');
  // Null until the user picks, so the page shows the language in force after every re-render.
  const [chosen, setChosen] = useState<Locale | null>(null);
  const shown = chosen ?? locale;
  const formRef = useRef<HTMLFormElement>(null);
  useKeepChoicesOnReset(formRef);

  const apply = async (formData: FormData) => {
    await setLocale(formData);
    setChosen(null);
  };

  return (
    <form ref={formRef} action={apply} className="flex max-w-[26rem] flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t('label')}</legend>
        {LOCALES.map((value) => (
          <label
            key={value}
            className={choiceCardClasses(shown === value, 'items-center gap-3 px-3 py-2.5')}
          >
            <input
              type="radio"
              name="locale"
              value={value}
              checked={shown === value}
              onChange={() => setChosen(value)}
              className={radioClasses()}
            />
            <span lang={value} className="text-base text-ink">
              {t(value)}
            </span>
          </label>
        ))}
      </fieldset>
      <div>
        <SubmitButton disabled={shown === locale}>{t('apply')}</SubmitButton>
      </div>
    </form>
  );
}
