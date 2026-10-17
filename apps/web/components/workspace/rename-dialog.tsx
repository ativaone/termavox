'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../ui/button.tsx';
import { TextField } from '../ui/text-field.tsx';
import { useRenameSession } from './hooks.ts';

export interface RenameTarget {
  sessionId: string;
  label: string;
}

/**
 * The session rename dialog (plan D-28), opened from a row's, a tile's or the phone list's menu:
 * a native modal dialog in the style of the language dialog, the current name prefilled and
 * selected, Enter saves, Escape cancels, and the daemon's refusal (a name of only spaces) shows
 * inline. One instance lives in the shell; `target` names the session being renamed.
 */
export function RenameDialog({
  target,
  onClose,
}: {
  target: RenameTarget | null;
  onClose(): void;
}) {
  const t = useTranslations('workspace.rename');
  const tm = useTranslations('workspace.menu');
  const tf = useTranslations('common.field');
  const rename = useRenameSession();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Open for a target, prefilled and selected; close when the target goes away.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (target) {
      setValue(target.label);
      setError(null);
      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else if (dialog.open) {
      dialog.close();
    }
  }, [target]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rename(target.sessionId, value);
      if (result.ok) onClose();
      else setError(result.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      className="card-solid m-auto w-[min(26rem,calc(100vw-2rem))] p-0 text-ink shadow-float backdrop:bg-ground-deep/70"
    >
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 py-4" noValidate>
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="font-semibold text-ink text-md">
            {t('title')}
          </h2>
          <p className="text-ink-muted text-sm">{t('help')}</p>
        </div>
        <TextField
          ref={inputRef}
          name="label"
          label={t('label')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          error={error ?? undefined}
          errorPrefix={tf('errorPrefix')}
          maxLength={1024}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            {t('save')}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {tm('cancel')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
