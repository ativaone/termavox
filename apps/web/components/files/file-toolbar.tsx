'use client';

import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { EyeIcon, FolderPlusIcon, RetryIcon, TerminalIcon, UploadIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { Spinner } from '../ui/spinner.tsx';

/** A pressed toggle carries the selection colour. */
const PRESSED =
  'aria-pressed:bg-accent-soft aria-pressed:text-accent aria-pressed:shadow-[inset_0_0_0_1px_var(--color-accent-ring)]';

/**
 * The panel's actions: Upload (the one primary, a multi-file picker), New folder, then the
 * terminal's folder, the hidden-files toggle and Refresh. Icon-only controls carry their name
 * as a label and a tooltip. On a phone every control is 44 px and Upload takes the spare width.
 */
export function FileToolbar({
  phone,
  disabled,
  onUpload,
  onNewFolder,
  terminalFolderKnown,
  onTerminalFolder,
  showHidden,
  onToggleHidden,
  onRefresh,
  refreshing,
}: {
  phone: boolean;
  /** Nothing listed (not connected, no SFTP): only the toggles that need no folder work. */
  disabled: boolean;
  onUpload(files: File[]): void;
  onNewFolder(): void;
  terminalFolderKnown: boolean;
  onTerminalFolder(): void;
  showHidden: boolean;
  onToggleHidden(): void;
  onRefresh(): void;
  refreshing: boolean;
}) {
  const t = useTranslations('files.toolbar');
  const picker = useRef<HTMLInputElement>(null);
  const size = phone ? 'lg' : 'sm';
  const iconSize = phone ? 20 : 16;
  const quiet = phone ? 'secondary' : 'quiet';
  const terminalLabel = terminalFolderKnown ? t('terminalFolder') : t('terminalFolderUnknown');

  return (
    <div
      role="toolbar"
      aria-label={t('label')}
      className={cx(
        'flex shrink-0 items-center gap-1',
        phone ? 'gap-1.5 px-3 pb-2.5' : 'h-12 px-2.5',
      )}
    >
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = '';
          if (files.length > 0) onUpload(files);
        }}
      />
      <Button
        variant="primary"
        size={size}
        disabled={disabled}
        onClick={() => picker.current?.click()}
        icon={<UploadIcon size={iconSize} />}
        className={phone ? 'flex-1' : undefined}
      >
        {t('upload')}
      </Button>
      {phone ? (
        <Button
          variant="secondary"
          size={size}
          iconOnly
          disabled={disabled}
          onClick={onNewFolder}
          aria-label={t('newFolder')}
          title={t('newFolder')}
          icon={<FolderPlusIcon size={iconSize} />}
        />
      ) : (
        <Button
          variant="secondary"
          size={size}
          disabled={disabled}
          onClick={onNewFolder}
          title={t('newFolder')}
          icon={<FolderPlusIcon size={iconSize} />}
          className="@max-[21rem]:w-8 @max-[21rem]:px-0"
        >
          <span className="@max-[21rem]:sr-only">{t('newFolder')}</span>
        </Button>
      )}
      <span className="flex-1" />
      <Button
        variant={quiet}
        size={size}
        iconOnly
        disabled={disabled || !terminalFolderKnown}
        onClick={onTerminalFolder}
        aria-label={terminalLabel}
        title={terminalLabel}
        icon={<TerminalIcon size={iconSize} />}
      />
      <Button
        variant={quiet}
        size={size}
        iconOnly
        aria-pressed={showHidden}
        onClick={onToggleHidden}
        aria-label={t('hidden')}
        title={t('hidden')}
        icon={<EyeIcon size={iconSize} />}
        className={PRESSED}
      />
      <Button
        variant={quiet}
        size={size}
        iconOnly
        disabled={disabled}
        aria-busy={refreshing || undefined}
        onClick={onRefresh}
        aria-label={t('refresh')}
        title={t('refresh')}
        // Stays enabled while it works, so the keyboard focus never drops off it.
        icon={refreshing ? <Spinner size={iconSize} /> : <RetryIcon size={iconSize} />}
      />
    </div>
  );
}
