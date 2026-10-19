'use client';

import { useTranslations } from 'next-intl';
import { CloseIcon, DownloadIcon, PencilIcon, TrashIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';

/**
 * What can be done with the selection: Download (files and links to files), Rename (exactly one
 * entry) and Delete (always confirmed), as labelled buttons, with the count and a way to clear
 * it. A lit `accent-soft` strip, the selection's colour. One row where the panel is wide enough;
 * narrower, the count and Clear stay on the first row and the actions take the second, so no
 * label is cut. On a phone it sits at the bottom, always in two rows, with 44 px controls.
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
  const iconSize = phone ? 18 : 15;
  // Small type at the 44 px touch height on a phone, sharing the row's width.
  const action = phone ? 'h-11 flex-1' : undefined;
  return (
    <div
      role="toolbar"
      aria-label={t('count', { count })}
      className={cx(
        'grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-control bg-accent-soft',
        phone ? 'mx-3 mt-2 mb-3 gap-y-1.5 p-1.5 ps-3' : 'mx-2.5 mb-2 p-1 ps-3 @min-[30rem]:flex',
      )}
    >
      <span
        className={cx(
          'col-start-1 row-start-1 min-w-0 flex-1 truncate font-semibold tabular-nums',
          phone ? 'text-base' : 'text-sm',
        )}
        aria-live="polite"
      >
        {t('count', { count })}
      </span>
      <div className="col-span-2 row-start-2 flex items-center gap-1">
        <Button
          variant="secondary"
          size="sm"
          disabled={!canDownload}
          onClick={onDownload}
          icon={<DownloadIcon size={iconSize} />}
          className={action}
        >
          {t('download')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canRename}
          onClick={onRename}
          icon={<PencilIcon size={iconSize} />}
          className={action}
        >
          {t('rename')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          isolated={false}
          onClick={onDelete}
          icon={<TrashIcon size={iconSize} />}
          className={cx(action, 'ms-1')}
        >
          {t('delete')}
        </Button>
      </div>
      <Button
        variant="quiet"
        size={phone ? 'lg' : 'sm'}
        iconOnly
        onClick={onClear}
        aria-label={t('clear')}
        title={t('clear')}
        icon={<CloseIcon size={phone ? 20 : 15} />}
        className="col-start-2 row-start-1"
      />
    </div>
  );
}
