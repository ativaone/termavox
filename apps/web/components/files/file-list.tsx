'use client';

import type { FileEntry } from '@termavox/protocol/client';
import { useTranslations } from 'next-intl';
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { displayName } from '../../lib/files/display-name.ts';
import { isFolderLike, type Selection, selectionState } from '../../lib/files/listing.ts';
import { CheckIcon, FolderPlusIcon, MinusIcon } from '../icons/index.tsx';
import { cx } from '../ui/cx.ts';
import { FileRow, ROW_COLUMNS } from './file-row.tsx';
import { NameField } from './name-field.tsx';

const PAGE = 10;

/**
 * The folder's entries as a multi-select list with one roving tab stop: arrows, Home, End and
 * Page keys move; Space selects; Enter opens a folder (selects a file); F2 renames; Delete asks
 * to delete; Escape clears the selection; Ctrl/⌘A selects all. A select-all checkbox and the
 * column labels sit above it on desktop. Long folders render cheaply: rows off screen skip
 * layout and paint (`content-visibility`).
 */
export function FileList({
  entries,
  folderName,
  selection,
  phone,
  now,
  emptyText,
  focusRequest,
  renaming,
  creating,
  onToggle,
  onSetAll,
  onClear,
  onOpen,
  onDeleteRequest,
  onRenameStart,
  onRenameSubmit,
  onRenameCancel,
  onCreateSubmit,
  onCreateCancel,
}: {
  /** Visible entries, in display order. */
  entries: FileEntry[];
  folderName: string;
  selection: Selection;
  phone: boolean;
  now: number;
  emptyText: string;
  /** Moves the tab stop (and the focus) to this entry, e.g. after a rename. */
  focusRequest: { name: string; seq: number } | null;
  renaming: string | null;
  creating: boolean;
  onToggle(name: string): void;
  onSetAll(on: boolean): void;
  onClear(): void;
  onOpen(entry: FileEntry): void;
  onDeleteRequest(entry: FileEntry): void;
  onRenameStart(entry: FileEntry): void;
  onRenameSubmit(entry: FileEntry, name: string): Promise<string | null>;
  onRenameCancel(): void;
  onCreateSubmit(name: string): Promise<string | null>;
  onCreateCancel(): void;
}) {
  const t = useTranslations('files');
  const list = useRef<HTMLDivElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [focusIndex, setFocusIndex] = useState(0);
  const names = entries.map((entry) => entry.name);
  const all = selectionState(selection, names);
  const taken = (name: string) => names.includes(name);

  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = all === 'some';
  }, [all]);

  // A new folder on screen starts at its first entry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the folder changing is the trigger
  useEffect(() => {
    setFocusIndex(0);
  }, [folderName]);

  const focusAt = (index: number) => {
    const target = Math.max(0, Math.min(entries.length - 1, index));
    setFocusIndex(target);
    list.current?.querySelector<HTMLElement>(`[data-index="${target}"]`)?.focus();
  };

  const handled = useRef(0);
  useEffect(() => {
    if (!focusRequest || handled.current === focusRequest.seq) return;
    const index = entries.findIndex((entry) => entry.name === focusRequest.name);
    if (index < 0) return;
    handled.current = focusRequest.seq;
    setFocusIndex(index);
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  }, [focusRequest, entries]);

  const activate = (entry: FileEntry) => {
    if (isFolderLike(entry)) onOpen(entry);
    else onToggle(entry.name);
  };

  // Rows are memoized: they get stable handlers that reach the latest props.
  const latest = useRef({ onToggle, activate });
  useEffect(() => {
    latest.current = { onToggle, activate };
  });
  const toggleRow = useCallback((name: string) => latest.current.onToggle(name), []);
  const activateRow = useCallback((entry: FileEntry) => latest.current.activate(entry), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    const index = Math.min(focusIndex, entries.length - 1);
    const entry = entries[index];
    if (!entry) return;
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'ArrowDown') focusAt(index + 1);
    else if (event.key === 'ArrowUp') focusAt(index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(entries.length - 1);
    else if (event.key === 'PageDown') focusAt(index + PAGE);
    else if (event.key === 'PageUp') focusAt(index - PAGE);
    else if (event.key === ' ' && !mod) onToggle(entry.name);
    else if (event.key === 'Enter' && !mod) activate(entry);
    else if (event.key === 'F2') onRenameStart(entry);
    else if (event.key === 'Delete') onDeleteRequest(entry);
    else if (event.key === 'Escape' && selection.size > 0) onClear();
    else if (mod && event.key.toLowerCase() === 'a') onSetAll(true);
    else return;
    event.preventDefault();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cx(
          'grid h-7 shrink-0 items-center gap-1.5 border-line border-b font-semibold text-ink-muted text-xs',
          phone ? 'grid-cols-[2.25rem_minmax(0,1fr)] px-2' : cx('ps-2.5 pe-3', ROW_COLUMNS),
        )}
      >
        <span className={cx('flex items-center', phone ? 'justify-center' : 'ps-1')}>
          <span className={cx('relative inline-flex shrink-0', phone ? 'size-5' : 'size-4')}>
            <input
              ref={selectAll}
              type="checkbox"
              checked={all === 'all' && entries.length > 0}
              disabled={entries.length === 0}
              onChange={(event) => onSetAll(event.target.checked)}
              aria-label={t('list.selectAll')}
              title={t('list.selectAll')}
              className={cx(
                'peer size-full cursor-pointer appearance-none rounded-xs border border-line-strong bg-field',
                'transition-[background-color,border-color] duration-(--duration-step) ease-(--ease-out)',
                'hover:border-white/50 checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                'disabled:cursor-not-allowed disabled:border-line disabled:bg-surface',
              )}
            />
            <CheckIcon
              size={phone ? 16 : 13}
              strokeWidth={2.5}
              className="pointer-events-none invisible absolute inset-0 m-auto text-on-accent peer-checked:visible"
            />
            <MinusIcon
              size={phone ? 16 : 13}
              strokeWidth={2.5}
              className="pointer-events-none invisible absolute inset-0 m-auto text-on-accent peer-indeterminate:visible"
            />
          </span>
        </span>
        <span>{t('list.name')}</span>
        {phone ? null : (
          <>
            <span className="text-end">{t('list.size')}</span>
            <span className="hidden text-end @min-[22rem]:block">{t('list.modified')}</span>
          </>
        )}
      </div>

      {creating ? (
        <div
          className={cx(
            'mx-1.5 mt-1 flex shrink-0 items-start gap-2 rounded-sm bg-surface px-2',
            phone ? 'min-h-13 items-center' : 'min-h-[34px]',
          )}
        >
          <FolderPlusIcon size={phone ? 20 : 16} className="mt-2 shrink-0 text-accent" />
          <NameField
            initial=""
            label={t('newFolder.label')}
            placeholder={t('newFolder.placeholder')}
            taken={taken}
            phone={phone}
            onSubmit={onCreateSubmit}
            onCancel={onCreateCancel}
          />
        </div>
      ) : null}

      {entries.length === 0 ? (
        creating ? null : (
          <p className="px-4 py-6 text-center text-ink-muted text-sm">{emptyText}</p>
        )
      ) : (
        <div
          ref={list}
          role="listbox"
          aria-multiselectable="true"
          aria-label={t('list.label', { folder: displayName(folderName).text })}
          aria-describedby={hintId}
          onKeyDown={onKeyDown}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-1.5 py-1"
        >
          {entries.map((entry, index) => (
            <FileRow
              key={entry.name}
              entry={entry}
              index={index}
              selected={selection.has(entry.name)}
              focused={index === Math.min(focusIndex, entries.length - 1)}
              phone={phone}
              now={now}
              onToggle={toggleRow}
              onActivate={activateRow}
              onFocusRow={setFocusIndex}
              nameSlot={
                renaming === entry.name ? (
                  <NameField
                    initial={entry.name}
                    label={t('rename.label', { name: displayName(entry.name).text })}
                    taken={(name) => name !== entry.name && taken(name)}
                    phone={phone}
                    onSubmit={(name) => onRenameSubmit(entry, name)}
                    onCancel={onRenameCancel}
                  />
                ) : null
              }
            />
          ))}
        </div>
      )}
      <p id={hintId} className="sr-only">
        {t('keyboardHint')}
      </p>
    </div>
  );
}
