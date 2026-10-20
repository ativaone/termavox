'use client';

import type { FileEntry } from '@termdock/protocol/client';
import { useLocale, useTranslations } from 'next-intl';
import { memo, type ReactNode } from 'react';
import { formatFullTime, formatModified, formatSize } from '../../lib/files/format.ts';
import { isDangling, isFolderLike, isHidden } from '../../lib/files/listing.ts';
import { CheckIcon, FileIcon, FileLinkIcon, FolderIcon, FolderLinkIcon } from '../icons/index.tsx';
import { cx } from '../ui/cx.ts';
import { FileName, withNames } from './file-name.tsx';

/** Desktop columns: check, name, size, then modified once the panel is wide enough. */
export const ROW_COLUMNS =
  'grid-cols-[1.5rem_minmax(0,1fr)_4.5rem] @min-[22rem]:grid-cols-[1.5rem_minmax(0,1fr)_4.5rem_5.75rem]';

/** The well of a selection checkbox, drawn like the form checkbox at 16 px. */
export function CheckMark({ checked, phone }: { checked: boolean; phone: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex shrink-0 items-center justify-center rounded-xs border transition-[background-color,border-color] duration-(--duration-step) ease-(--ease-out)',
        phone ? 'size-5' : 'size-4',
        checked ? 'border-accent bg-accent text-on-accent' : 'border-line-strong bg-field',
      )}
    >
      {checked ? <CheckIcon size={phone ? 16 : 13} strokeWidth={2.5} /> : null}
    </span>
  );
}

function EntryIcon({ entry, size }: { entry: FileEntry; size: number }) {
  if (entry.type === 'dir') return <FolderIcon size={size} className="shrink-0 text-accent" />;
  if (entry.type === 'link' && entry.target === 'dir') {
    return <FolderLinkIcon size={size} className="shrink-0 text-accent" />;
  }
  if (entry.type === 'link')
    return <FileLinkIcon size={size} className="shrink-0 text-ink-muted" />;
  return <FileIcon size={size} className="shrink-0 text-ink-muted" />;
}

/**
 * One entry of the listing, an option of the list (selected or not): the check, the kind's icon,
 * the name (folders in semibold, dot-files muted), a link's target or "broken link", then size
 * and modified time on desktop, or both under the name on a phone. Clicking a folder's name opens
 * it and a file's name selects it; on a phone the whole row does.
 */
export const FileRow = memo(function FileRow({
  entry,
  index,
  selected,
  focused,
  phone,
  now,
  nameSlot,
  onToggle,
  onActivate,
  onFocusRow,
}: {
  entry: FileEntry;
  index: number;
  selected: boolean;
  /** Holds the list's roving tab stop. */
  focused: boolean;
  phone: boolean;
  now: number;
  /** Replaces the name while it is being renamed. */
  nameSlot: ReactNode | null;
  /** Stable across renders (rows are memoized): they take the entry. */
  onToggle(name: string): void;
  onActivate(entry: FileEntry): void;
  onFocusRow(index: number): void;
}) {
  const toggle = () => onToggle(entry.name);
  const activate = () => onActivate(entry);
  const t = useTranslations('files.list');
  const locale = useLocale();
  const folder = isFolderLike(entry);
  const dangling = isDangling(entry);
  const modified = formatModified(entry.mtime, now, locale);
  const size = folder || dangling ? '—' : formatSize(entry.size, locale);
  const linkNote =
    entry.type === 'link' ? (
      dangling ? (
        <span className="shrink-0 text-danger text-xs">{t('dangling')}</span>
      ) : entry.linkTo ? (
        // The link's target gives way first: the name is what the row is read by.
        <span className="min-w-0 flex-1 truncate text-ink-muted text-xs">
          {withNames([entry.linkTo], (target) => t('linkTo', { target }))}
        </span>
      ) : null
    ) : null;
  const name = nameSlot ?? (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the pointer's shortcut; the option itself takes the keys (Enter opens, Space selects)
    <span
      className={cx(
        'min-w-0 truncate',
        // Beside a link's target, the name keeps its width up to most of the cell.
        !phone && entry.type === 'link' && entry.linkTo && !dangling && 'max-w-[70%] shrink-0',
        folder ? 'font-semibold' : 'font-normal',
        isHidden(entry.name) ? 'text-ink-muted' : 'text-ink',
        !phone && 'cursor-pointer hover:underline hover:decoration-line-strong',
      )}
      onClick={
        phone
          ? undefined
          : (event) => {
              event.stopPropagation();
              activate();
            }
      }
    >
      <FileName name={entry.name} />
    </span>
  );

  let phoneMeta: ReactNode;
  if (entry.type === 'link') {
    phoneMeta = entry.linkTo
      ? withNames([entry.linkTo], (target) => t('linkMeta', { target }))
      : t('linkMeta', { target: '?' });
    if (dangling) {
      phoneMeta = (
        <>
          {phoneMeta} · {t('dangling')}
        </>
      );
    }
  } else if (folder) {
    phoneMeta = t('folderMeta', { modified });
  } else {
    phoneMeta = t('fileMeta', { size, modified });
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the list handles the keys of its options (roving focus)
    <div
      role="option"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      data-index={index}
      onFocus={() => onFocusRow(index)}
      onClick={phone && !nameSlot ? activate : undefined}
      onDoubleClick={!phone && folder && !nameSlot ? activate : undefined}
      className={cx(
        'rounded-sm outline-none [content-visibility:auto]',
        'transition-colors duration-(--duration-step) ease-(--ease-out)',
        'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
        selected ? 'bg-accent-soft' : 'hover:bg-surface',
        phone
          ? 'grid min-h-13 grid-cols-[2.25rem_1.25rem_minmax(0,1fr)] items-center gap-2.5 pe-2 [contain-intrinsic-size:auto_52px]'
          : cx(
              'grid min-h-[34px] items-center gap-1.5 ps-1 pe-1.5 text-sm [contain-intrinsic-size:auto_34px]',
              ROW_COLUMNS,
            ),
      )}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the check is drawn; Space on the option is its keyboard way */}
      <span
        className={cx('flex h-full cursor-pointer items-center', phone ? 'justify-center' : 'ps-1')}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
      >
        <CheckMark checked={selected} phone={phone} />
      </span>
      {phone ? (
        <>
          <EntryIcon entry={entry} size={20} />
          <span className="flex min-w-0 flex-col py-1.5">
            <span className="flex min-w-0 text-base">{name}</span>
            <span className="truncate text-ink-muted text-xs tabular-nums">{phoneMeta}</span>
          </span>
        </>
      ) : (
        <>
          <span className="flex min-w-0 items-center gap-2">
            <EntryIcon entry={entry} size={16} />
            {name}
            {nameSlot ? null : linkNote}
          </span>
          <span className="truncate text-end font-data text-ink-muted text-xs">{size}</span>
          <span
            className="hidden truncate text-end text-ink-muted text-xs tabular-nums @min-[22rem]:block"
            title={formatFullTime(entry.mtime, locale)}
          >
            {modified}
          </span>
        </>
      )}
    </div>
  );
});
