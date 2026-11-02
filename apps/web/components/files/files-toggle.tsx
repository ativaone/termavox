'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useSyncExternalStore } from 'react';
import type { PaneFilesState } from '../../lib/files/pane-state.ts';
import type { SessionEntry } from '../../lib/terminal/connection.ts';
import { FolderIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { useWorkspace } from '../workspace/workspace-context.tsx';

/**
 * The file panel can open on this session: file transfer is on for the installation, and the
 * session is an SSH one that has not ended (local sessions have no file system adapter yet).
 */
export function filesAllowedFor(
  filesEnabled: boolean,
  session: Pick<SessionEntry, 'kind' | 'status'> | undefined,
): boolean {
  return filesEnabled && session?.kind === 'ssh' && session.status !== 'ended';
}

export function useFilesAllowed(sessionId: string | null): boolean {
  const { filesEnabled, sessions } = useWorkspace();
  return filesAllowedFor(filesEnabled, sessionId ? sessions.get(sessionId) : undefined);
}

/** The pane's file panel state for its session (null: never opened, nothing remembered). */
export function usePaneFiles(paneId: string, sessionId: string | null): PaneFilesState | null {
  const { filePanes } = useWorkspace();
  const read = useCallback(
    () => (sessionId ? filePanes.get(paneId, sessionId) : null),
    [filePanes, paneId, sessionId],
  );
  return useSyncExternalStore(filePanes.subscribe, read, read);
}

/**
 * One field of the pane's file panel state, re-rendering only when that value changes (the panel
 * must not re-render while its divider is dragged).
 */
export function usePaneFilesField<T extends string | number | boolean | null>(
  paneId: string,
  sessionId: string,
  pick: (state: PaneFilesState | null) => T,
): T {
  const { filePanes } = useWorkspace();
  const read = () => pick(filePanes.get(paneId, sessionId));
  return useSyncExternalStore(filePanes.subscribe, read, read);
}

function useToggle(paneId: string, sessionId: string) {
  const { filePanes } = useWorkspace();
  const open = usePaneFiles(paneId, sessionId)?.open ?? false;
  const toggle = useCallback(
    () => filePanes.toggle(paneId, sessionId),
    [filePanes, paneId, sessionId],
  );
  return { open, toggle };
}

/** A pressed toggle carries the selection colour, as a lit tab does. */
const PRESSED =
  'aria-pressed:bg-accent-soft aria-pressed:text-ink aria-pressed:shadow-[inset_0_0_0_1px_var(--color-accent-ring)]';

/** The Files toggle in a desktop pane's caption; its label folds to the glyph in a narrow pane. */
export function FilesPaneButton({
  paneId,
  sessionId,
  label,
}: {
  paneId: string;
  sessionId: string;
  label: string;
}) {
  const t = useTranslations('files');
  const { open, toggle } = useToggle(paneId, sessionId);
  const allowed = useFilesAllowed(sessionId);
  if (!allowed) return null;
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={toggle}
      aria-label={t('toggleLabel', { label })}
      title={t('toggle')}
      className={cx(
        'flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-2 font-semibold text-sm',
        'bg-surface-raised text-ink hover:bg-surface-pressed active:bg-surface-pressed',
        'transition-colors duration-(--duration-step) ease-(--ease-out)',
        'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
        '@max-[18rem]:w-7 @max-[18rem]:px-0',
        PRESSED,
      )}
    >
      <FolderIcon size={16} className={open ? 'text-accent' : undefined} />
      <span className="@max-[18rem]:sr-only">{t('toggle')}</span>
    </button>
  );
}

/** The phone pane header's Files button: switches to the full-screen files view. */
export function FilesPhoneButton({ paneId, sessionId }: { paneId: string; sessionId: string }) {
  const t = useTranslations('files');
  const { toggle } = useToggle(paneId, sessionId);
  const allowed = useFilesAllowed(sessionId);
  if (!allowed) return null;
  return (
    <Button
      variant="quiet"
      size="lg"
      iconOnly
      onClick={toggle}
      aria-label={t('phone.open')}
      title={t('phone.open')}
      icon={<FolderIcon size={20} />}
    />
  );
}
