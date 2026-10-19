'use client';

import { useTranslations } from 'next-intl';
import { CloseIcon, DownloadIcon, PencilIcon, TrashIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';

/**
 * What can be done with the selection: Download (files and links to files), Rename (exactly one
 * entry) and Delete (always confirmed), with the count and a way to clear it. A lit
 * `accent-soft` strip, the selection's colour; on a phone it sits at the bottom, 44 px controls.
 */
export function SelectionBar({
  count,
  canRename,
  canDownload,
  phone,
  onDownload,
  onRename,
  onDelete,
  onClear,
}: {
  count: number;
  canRename: boolean;
  canDownload: boolean;
  phone: boolean;
  onDownload(): void;
  onRename(): void;
  onDelete(): void;
  onClear(): void;
}) {
  const t = useTranslations('files.selection');
  const size = phone ? 'lg' : 'sm';
  const iconSize = phone ? 20 : 15;
  return (
    <div
      role="toolbar"
      aria-label={t('count', { count })}
      className={cx(
        'flex shrink-0 items-center gap-1 rounded-control bg-accent-soft',
        phone ? 'mx-3 mt-2 mb-3 gap-1.5 p-1.5 ps-3' : 'mx-2.5 mb-2 p-1 ps-3',
      )}
    >
      <span
        className={cx(
          'min-w-0 flex-1 truncate font-semibold tabular-nums',
          phone ? 'text-base' : 'text-sm',
        )}
        aria-live="polite"
      >
        {t('count', { count })}
      </span>
      <Button
        variant="secondary"
        size={size}
        disabled={!canDownload}
        onClick={onDownload}
        icon={<DownloadIcon size={iconSize} />}
        title={t('download')}
        className="@max-[23rem]:w-8 @max-[23rem]:px-0"
      >
        <span className={phone ? 'sr-only' : '@max-[23rem]:sr-only'}>{t('download')}</span>
      </Button>
      <Button
        variant="quiet"
        size={size}
        iconOnly
        disabled={!canRename}
        onClick={onRename}
        aria-label={t('rename')}
        title={t('rename')}
        icon={<PencilIcon size={iconSize} />}
      />
      <Button
        variant="destructive"
        size={size}
        iconOnly
        isolated={false}
        onClick={onDelete}
        aria-label={t('delete')}
        title={t('delete')}
        icon={<TrashIcon size={iconSize} />}
        className={phone ? 'ms-3' : 'ms-2'}
      />
      <Button
        variant="quiet"
        size={size}
        iconOnly
        onClick={onClear}
        aria-label={t('clear')}
        title={t('clear')}
        icon={<CloseIcon size={iconSize} />}
      />
    </div>
  );
}
