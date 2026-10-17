'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { terminateAllSessions } from '../../lib/actions/sessions.ts';
import { Button } from '../ui/button.tsx';
import { Notice } from '../ui/notice.tsx';

/**
 * "End all sessions…" (plan D-30) at the foot of the session list: a quiet control that opens a
 * native modal dialog (the rename dialog's shape) stating how many sessions end and what that
 * does, with the destructive button inside it and the focus on Cancel. The sessions then end
 * through the usual `session.status` updates; a refusal shows in the dialog. Rendered only while
 * at least one session has not ended.
 */
export function EndAllSessions({ count }: { count: number }) {
  const t = useTranslations('workspace.endAll');
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
      const result = await terminateAllSessions();
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
      <Button variant="quiet" size="sm" onClick={open} aria-haspopup="dialog">
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
