'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { setTheme } from '../../lib/actions/theme.ts';
import type { Theme } from '../../lib/preferences/theme.ts';
import { ThemeChoices } from '../theme-choices.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';

/** The theme on the account settings page (plan D-55): the dialog's choices, applied in place. */
export function ThemeForm({ theme }: { theme: Theme }) {
  const t = useTranslations('common.theme');
  // Null until the user picks, so the page shows the theme in force after every re-render.
  const [chosen, setChosen] = useState<Theme | null>(null);
  const shown = chosen ?? theme;

  const apply = async (formData: FormData) => {
    await setTheme(formData);
    setChosen(null);
  };

  return (
    <form action={apply} className="flex flex-col gap-4">
      <ThemeChoices chosen={shown} onChange={setChosen} />
      <div>
        <SubmitButton disabled={shown === theme}>{t('apply')}</SubmitButton>
      </div>
    </form>
  );
}
