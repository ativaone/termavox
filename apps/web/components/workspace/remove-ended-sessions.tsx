'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { removeEndedSessions } from '../../lib/actions/sessions.ts';
import { Button } from '../ui/button.tsx';
import { Notice } from '../ui/notice.tsx';

/**
 * "Remove all ended…" (plan D-32) at the foot of the expanded Ended group: a quiet control that
 * opens a native modal dialog (End all's shape) stating how many ended sessions leave the list,
 * with their history, and the focus on Cancel. The list follows through `session.removed`.
 */
export function RemoveEndedSessions({ count }: { count: number }) {
  const t = useTranslations('workspace.removeEnded');
  const tm = useTranslations('workspace.menu');
  const tn = useTranslations('workspace.notice');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setError(null);
    dialogRef.current?.showModal();
    dialogRef.current?.querySelector<HTMLElement>('[data-cancel]')?.focus();
  };
  const close = () => dialogRef.current?.close();

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await removeEndedSessions();
      if (result.ok) close();
      else setError(result.message);
    } catch {
      setError(tn('actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        onClick={open}
        aria-haspopup="dialog"
        className="self-start"
      >
        {t('open')}
      </Button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="card-solid m-auto w-[min(28rem,calc(100vw-2rem))] p-0 text-ink shadow-float backdrop:bg-ground-deep/70"
      >
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="font-semibold text-ink text-md">
              {t('title')}
            </h2>
            <p className="text-pretty text-base text-ink-muted">{t('body', { count })}</p>
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="destructive"
              isolated={false}
              loading={busy}
              onClick={() => void confirm()}
            >
              {t('confirm', { count })}
            </Button>
            <Button data-cancel="" variant="secondary" onClick={close}>
              {tm('cancel')}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
