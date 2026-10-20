'use client';

import type { FileEntry } from '@termdock/protocol/client';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef } from 'react';
import { displayName } from '../../lib/files/display-name.ts';
import { countKinds } from '../../lib/files/listing.ts';
import { Button } from '../ui/button.tsx';
import { Notice } from '../ui/notice.tsx';

/**
 * Delete is always confirmed (plan §5.12): a native modal dialog in End all's shape. The title
 * counts folders, files and links; a danger notice says folders go with everything inside them
 * (naming the folder when it is the only entry) and that nothing comes back; a line says links
 * are removed as links. The destructive button sits beside Cancel, which takes the focus.
 */
export function DeleteDialog({
  entries,
  onConfirm,
  onCancel,
}: {
  entries: FileEntry[];
  onConfirm(): void;
  onCancel(): void;
}) {
  const t = useTranslations('files.delete');
  const tc = useTranslations('workspace.menu');
  const locale = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const counts = countKinds(entries);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    element?.querySelector<HTMLElement>('[data-cancel]')?.focus();
    return () => {
      if (element?.open) element.close();
    };
  }, []);

  const parts = [
    counts.folders > 0 ? t('folders', { count: counts.folders }) : null,
    counts.files > 0 ? t('files', { count: counts.files }) : null,
    counts.links > 0 ? t('links', { count: counts.links }) : null,
  ].filter((part): part is string => part !== null);
  const items = new Intl.ListFormat(locale, { type: 'conjunction' }).format(parts);
  const only = entries.length === 1 ? entries[0] : undefined;
  const folderName = only?.type === 'dir' ? displayName(only.name) : null;

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="card-solid m-auto w-[min(28rem,calc(100vw-2rem))] p-0 text-ink shadow-float backdrop:bg-ground-deep/70"
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <h2 id={titleId} className="font-semibold text-ink text-md">
          {t('title', { items })}
        </h2>
        <Notice tone="danger">
          {folderName
            ? t.rich('oneFolder', {
                name: folderName.text,
                path: (chunks) => (
                  <bdi
                    dir="ltr"
                    className="font-mono text-sm"
                    title={folderName.title ?? undefined}
                  >
                    {chunks}
                  </bdi>
                ),
              })
            : counts.folders > 0
              ? t('foldersWarning')
              : t('warning')}
        </Notice>
        {counts.links > 0 ? <p className="text-ink-muted text-sm">{t('linksNote')}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="destructive" isolated={false} onClick={onConfirm}>
            {t('confirm')}
          </Button>
          <Button data-cancel="" variant="secondary" onClick={onCancel}>
            {tc('cancel')}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
