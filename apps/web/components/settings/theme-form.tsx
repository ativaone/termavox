'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { setTheme } from '../../lib/actions/theme.ts';
import type { Theme } from '../../lib/preferences/theme.ts';
import { ThemeChoices } from '../theme-choices.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { useKeepChoicesOnReset } from '../ui/use-keep-choices.ts';

/**
 * The theme on Settings → Theme (plan D-55, D-60): System, Light and Dark as choice cards with
 * their miniatures, and Apply, which re-renders the page in the chosen theme.
 */
export function ThemeForm({ theme }: { theme: Theme }) {
  const t = useTranslations('common.theme');
  // Null until the user picks, so the page shows the theme in force after every re-render.
  const [chosen, setChosen] = useState<Theme | null>(null);
  const shown = chosen ?? theme;
  const formRef = useRef<HTMLFormElement>(null);
  useKeepChoicesOnReset(formRef);

  const apply = async (formData: FormData) => {
    await setTheme(formData);
    setChosen(null);
  };

  return (
    <form ref={formRef} action={apply} className="flex max-w-[26rem] flex-col gap-4">
      <ThemeChoices chosen={shown} onChange={setChosen} />
      <div>
        <SubmitButton disabled={shown === theme}>{t('apply')}</SubmitButton>
      </div>
    </form>
  );
}
