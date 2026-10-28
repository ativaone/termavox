'use client';

import { useTranslations } from 'next-intl';
import { type RefObject, useId, useRef, useState, useSyncExternalStore } from 'react';
import { setTheme } from '../../lib/actions/theme.ts';
import { DEFAULT_THEME, isTheme, type Theme } from '../../lib/preferences/theme.ts';
import { ThemeChoices } from '../theme-choices.tsx';
import { Button } from '../ui/button.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { useKeepChoicesOnReset } from '../ui/use-keep-choices.ts';

/**
 * The theme picker behind the account menu's "Theme…" item (plan D-55), built like the language
 * dialog (plan D-28): a rare setting never takes room in the menu itself. Apply re-renders the
 * page in the chosen theme. The account settings page keeps the same choice as a plain form.
 */
export function ThemeDialog({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement | null> }) {
  const t = useTranslations('common.theme');
  const ta = useTranslations('workspace.account');
  const ts = useTranslations('settings.account.theme');
  const titleId = useId();
  const current = useDocumentTheme();
  // Null until the user picks: the dialog then shows the theme in force, whatever it became.
  const [chosen, setChosen] = useState<Theme | null>(null);
  const shown = chosen ?? current;
  const formRef = useRef<HTMLFormElement>(null);
  useKeepChoicesOnReset(formRef);

  const apply = async (formData: FormData) => {
    await setTheme(formData);
    dialogRef.current?.close();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={() => setChosen(null)}
      className="card-solid m-auto w-[min(26rem,calc(100vw-2rem))] p-0 text-ink shadow-float backdrop:bg-ground-deep/70"
    >
      <form ref={formRef} action={apply} className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="font-semibold text-ink text-md">
            {t('label')}
          </h2>
          <p className="text-ink-muted text-sm">{ts('intro')}</p>
        </div>
        <ThemeChoices chosen={shown} onChange={setChosen} />
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton disabled={shown === current}>{t('apply')}</SubmitButton>
          <Button variant="secondary" onClick={() => dialogRef.current?.close()}>
            {ta('cancel')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

/** The theme on `<html data-theme>` (the root layout's), kept current as the route re-renders. */
function useDocumentTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, readTheme, () => DEFAULT_THEME);
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

function readTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return isTheme(value) ? value : DEFAULT_THEME;
}
