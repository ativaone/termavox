'use client';

import { FILES_LIMITS, type FileEntry } from '@termdock/protocol/client';
import { useLocale, useTranslations } from 'next-intl';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sessionFiles } from '../../lib/files/client.ts';
import {
  type ConflictChoice,
  findConflicts,
  planUploads,
  uniqueName,
} from '../../lib/files/conflicts.ts';
import { ClientFileCode, FileCode, fileErrorCode } from '../../lib/files/errors.ts';
import {
  EMPTY_SELECTION,
  hiddenCount,
  isDownloadable,
  isFolderLike,
  planDownloads,
  pruneSelection,
  type Selection,
  selectedEntries,
  setSelected,
  toggleSelection,
  visibleEntries,
} from '../../lib/files/listing.ts';
import { baseName, joinPath } from '../../lib/files/paths.ts';
import { sessionTarget } from '../../lib/sessions/target.ts';
import { CloseIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { Notice, type NoticeTone } from '../ui/notice.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { useNow } from '../workspace/hooks.ts';
import { useWorkspace } from '../workspace/workspace-context.tsx';
import { ConflictDialog } from './conflict-dialog.tsx';
import { DeleteDialog } from './delete-dialog.tsx';
import { DropOverlay, useFileDrop } from './drop-zone.tsx';
import { FileList } from './file-list.tsx';
import { FilePathBar } from './file-path-bar.tsx';
import { FileToolbar } from './file-toolbar.tsx';
import { usePaneFilesField } from './files-toggle.tsx';
import { SelectionBar } from './selection-bar.tsx';
import { TransferTray } from './transfer-tray.tsx';
import { DisabledCard, ListError, OfflineCard, SftpCard } from './unavailable.tsx';
import { useFileBrowser } from './use-file-browser.ts';
import { useFileErrorText } from './use-file-text.ts';

const NOTICE_MS = 8_000;
const MAX_NOTICES = 3;
/** Uploads that finish close together refresh the folder once. */
const REFRESH_DELAY_MS = 400;

interface PanelNotice {
  id: number;
  tone: NoticeTone;
  title?: string;
  text: string;
}

interface PendingUpload {
  dir: string;
  batch: Array<{ name: string; size: number; source: File }>;
  existing: ReadonlySet<string>;
  conflicts: string[];
}

/**
 * The file panel of one pane (plan D-39, §5.12): the session's server as the session's user,
 * over the session's own SSH connection. Docked beside the terminal (or over it) in a pane, or
 * a full-screen view on a phone. It lists a folder, moves through it (path bar, folders, Up, the
 * terminal's folder), uploads (picker or drop, name conflicts asked once per batch) and
 * downloads (one browser download per file) through the tab's transfer queue, renames, creates
 * folders and deletes (always confirmed, stoppable). When it cannot work it says why: the session
 * is not connected, the server offers no SFTP, or file transfer is off.
 */
export const FilePanel = memo(function FilePanel({
  paneId,
  sessionId,
  variant,
  onClose,
}: {
  paneId: string;
  sessionId: string;
  variant: 'pane' | 'phone';
  onClose(): void;
}) {
  const t = useTranslations('files');
  const tw = useTranslations('workspace');
  const locale = useLocale();
  const { connection, connectionState, sessions, labels, filePanes, transfers } = useWorkspace();
  const errorText = useFileErrorText();
  const phone = variant === 'phone';
  const now = useNow(60_000);

  const session = sessions.get(sessionId);
  const label = labels.get(sessionId)?.label ?? session?.label ?? tw('pane.loading');
  const target = session ? sessionTarget(session, tw('localTarget')) : '';
  const tabOnline = connectionState.status === 'open';
  const available = tabOnline && session?.state === 'ready';
  const showHidden = usePaneFilesField(paneId, sessionId, (pane) => pane?.showHidden ?? true);
  const rememberedPath = usePaneFilesField(paneId, sessionId, (pane) => pane?.path ?? null);
  const files = useMemo(() => sessionFiles(connection, sessionId), [connection, sessionId]);

  // ── notices ────────────────────────────────────────────────────────────────
  const [notices, setNotices] = useState<PanelNotice[]>([]);
  const noticeSeq = useRef(0);
  const notify = useCallback((notice: Omit<PanelNotice, 'id'>) => {
    const id = ++noticeSeq.current;
    setNotices((current) => [...current.slice(-(MAX_NOTICES - 1)), { id, ...notice }]);
    if (notice.tone !== 'danger') {
      setTimeout(() => setNotices((current) => current.filter((n) => n.id !== id)), NOTICE_MS);
    }
  }, []);
  const dismiss = (id: number) => setNotices((current) => current.filter((n) => n.id !== id));

  // ── listing ───────────────────────────────────────────────────────────────
  const browser = useFileBrowser({
    files,
    available,
    initialPath: rememberedPath,
    locale,
    onPath: (path) => filePanes.update(paneId, sessionId, { path }),
    onError: (code, message) => notify({ tone: 'danger', text: errorText(code, message) }),
  });
  const { state } = browser;
  const path = state.path;
  const pathRef = useRef(path);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  const visible = useMemo(
    () => visibleEntries(state.entries, showHidden),
    [state.entries, showHidden],
  );

  // ── selection and inline edits ────────────────────────────────────────────
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ name: string; seq: number } | null>(null);
  const focusOn = (name: string) => setFocusRequest((r) => ({ name, seq: (r?.seq ?? 0) + 1 }));

  // Another folder starts with nothing selected or edited.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the folder changing is the trigger
  useEffect(() => {
    setSelection(EMPTY_SELECTION);
    setRenaming(null);
    setCreating(false);
  }, [path]);
  // Entries that left the screen (refresh, hidden files hidden) leave the selection.
  useEffect(() => {
    setSelection((current) =>
      pruneSelection(
        current,
        visible.map((entry) => entry.name),
      ),
    );
  }, [visible]);

  const chosen = useMemo(() => selectedEntries(visible, selection), [visible, selection]);
  const taken = useMemo(() => new Set(state.entries.map((entry) => entry.name)), [state.entries]);

  const open = (entry: FileEntry) => {
    if (path) void browser.navigate(joinPath(path, entry.name));
  };

  const rename = async (entry: FileEntry, name: string): Promise<string | null> => {
    if (!path) return null;
    try {
      const result = await files.rename(joinPath(path, entry.name), joinPath(path, name));
      browser.applyEntry(result.entry, entry.name);
      setRenaming(null);
      setSelection((current) =>
        current.has(entry.name)
          ? toggleSelection(toggleSelection(current, entry.name), result.entry.name)
          : current,
      );
      focusOn(result.entry.name);
      return null;
    } catch (err) {
      return errorText(fileErrorCode(err), err instanceof Error ? err.message : undefined);
    }
  };

  const createFolder = async (name: string): Promise<string | null> => {
    if (!path) return null;
    try {
      const result = await files.mkdir(joinPath(path, name));
      browser.applyEntry(result.entry);
      setCreating(false);
      focusOn(result.entry.name);
      return null;
    } catch (err) {
      return errorText(fileErrorCode(err), err instanceof Error ? err.message : undefined);
    }
  };

  // ── delete ────────────────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState<FileEntry[] | null>(null);
  const [deleting, setDeleting] = useState<{ removed: number; stop(): void } | null>(null);

  const askDelete = (focused?: FileEntry) => {
    const targets = chosen.length > 0 ? chosen : focused ? [focused] : [];
    if (targets.length > 0) setConfirmDelete(targets);
  };

  const runDelete = async (targets: FileEntry[]) => {
    setConfirmDelete(null);
    if (!path) return;
    const controller = new AbortController();
    let removed = 0;
    setDeleting({ removed, stop: () => controller.abort() });
    const paths = targets.map((entry) => joinPath(path, entry.name));
    try {
      // At most 1 000 paths per request (FILES_LIMITS): larger selections go in turns.
      for (let start = 0; start < paths.length; start += FILES_LIMITS.removePaths) {
        const before = removed;
        const result = await files.remove(paths.slice(start, start + FILES_LIMITS.removePaths), {
          signal: controller.signal,
          onProgress: (count) => {
            removed = before + count;
            setDeleting((current) => current && { ...current, removed });
          },
        });
        removed = before + result.removed;
      }
      setSelection(EMPTY_SELECTION);
    } catch (err) {
      const code = fileErrorCode(err);
      if (code === FileCode.Cancelled) {
        notify({ tone: 'info', text: t('delete.stopped', { count: removed }) });
      } else {
        notify({
          tone: 'danger',
          text: errorText(code, err instanceof Error ? err.message : undefined),
        });
      }
    } finally {
      setDeleting(null);
      browser.refresh();
    }
  };

  // ── transfers ─────────────────────────────────────────────────────────────
  const [pending, setPending] = useState<PendingUpload | null>(null);

  const enqueue = (upload: PendingUpload, choice: ConflictChoice) => {
    const planned = planUploads(upload.batch, upload.existing, choice);
    transfers.enqueueUploads(
      sessionId,
      upload.dir,
      planned.map((item) => ({
        name: item.name,
        size: item.size,
        overwrite: item.overwrite,
        body: item.source,
      })),
    );
  };

  const upload = (picked: File[]) => {
    if (!path || picked.length === 0) return;
    const batch = picked.map((file) => ({ name: file.name, size: file.size, source: file }));
    const conflicts = findConflicts(
      batch.map((item) => item.name),
      taken,
    );
    const next: PendingUpload = { dir: path, batch, existing: taken, conflicts };
    if (conflicts.length > 0) setPending(next);
    else enqueue(next, 'skip');
  };

  const download = () => {
    if (!path) return;
    const plan = planDownloads(chosen);
    transfers.enqueueDownloads(
      sessionId,
      path,
      plan.files.map((entry) => ({
        path: joinPath(path, entry.name),
        name: entry.name,
        size: entry.size,
      })),
    );
    const folders = chosen.filter(isFolderLike).length;
    if (folders > 0)
      notify({ tone: 'info', text: t('selection.foldersSkipped', { count: folders }) });
  };

  // Finished uploads into the folder on screen refresh it (once for a burst); a proxy's 413
  // gets its own notice.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { refresh } = browser;
  useEffect(() => {
    const off = transfers.onSettled((job) => {
      if (job.sessionId !== sessionId) return;
      if (job.direction === 'upload' && job.state === 'done' && job.dir === pathRef.current) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(refresh, REFRESH_DELAY_MS);
      }
      if (job.state === 'failed' && job.error?.code === ClientFileCode.ProxyTooLarge) {
        notify({
          tone: 'danger',
          title: t('proxy.title', { name: job.name }),
          text: t('proxy.body'),
        });
      }
    });
    return () => {
      off();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [transfers, sessionId, refresh, notify, t]);

  const drop = useFileDrop({
    enabled: available && path !== null && state.problem === null,
    onFiles: (dropped, skipped) => {
      if (skipped > 0) notify({ tone: 'info', text: t('drop.foldersSkipped', { count: skipped }) });
      upload(dropped);
    },
  });

  // ── view ──────────────────────────────────────────────────────────────────
  const listing = available && state.problem === null && path !== null;
  const hidden = hiddenCount(state.entries);
  const emptyText = hidden > 0 && !showHidden ? t('list.emptyHidden') : t('list.empty');

  let body: ReactNode;
  if (!tabOnline) {
    body = <OfflineCard status="reconnecting" statusLabel="" tabOffline />;
  } else if (!available) {
    const status = session?.status ?? 'connecting';
    body = <OfflineCard status={status} statusLabel={tw(`status.${status}`)} tabOffline={false} />;
  } else if (state.problem?.kind === 'sftp') {
    body = <SftpCard target={target} onRetry={browser.reload} />;
  } else if (state.problem?.kind === 'disabled') {
    body = <DisabledCard />;
  } else if (state.problem?.kind === 'error') {
    const home = state.home;
    body = (
      <ListError
        message={errorText(state.problem.code, state.problem.message)}
        onRetry={browser.reload}
        onHome={home && home !== path ? () => void browser.navigate(home) : null}
      />
    );
  } else if (path === null) {
    body = (
      <p role="status" className="flex items-center gap-2 px-4 py-6 text-ink-muted text-sm">
        <Spinner size={14} />
        {t('list.loading')}
      </p>
    );
  } else {
    body = (
      <FileList
        entries={visible}
        folderName={baseName(path)}
        selection={selection}
        phone={phone}
        now={now}
        emptyText={emptyText}
        focusRequest={focusRequest}
        renaming={renaming}
        creating={creating}
        onToggle={(name) => setSelection((current) => toggleSelection(current, name))}
        onSetAll={(on) =>
          setSelection((current) =>
            setSelected(
              current,
              visible.map((entry) => entry.name),
              on,
            ),
          )
        }
        onClear={() => setSelection(EMPTY_SELECTION)}
        onOpen={open}
        onDeleteRequest={askDelete}
        onRenameStart={(entry) => {
          setCreating(false);
          setRenaming(entry.name);
        }}
        onRenameSubmit={rename}
        onRenameCancel={() => {
          const name = renaming;
          setRenaming(null);
          if (name) focusOn(name);
        }}
        onCreateSubmit={createFolder}
        onCreateCancel={() => setCreating(false)}
      />
    );
  }

  const selectionBar =
    listing && selection.size > 0 ? (
      <SelectionBar
        count={selection.size}
        canRename={selection.size === 1}
        canDownload={chosen.some(isDownloadable)}
        phone={phone}
        onDownload={download}
        onRename={() => {
          const only = chosen[0];
          if (only) {
            setCreating(false);
            setRenaming(only.name);
          }
        }}
        onDelete={() => askDelete()}
        onClear={() => setSelection(EMPTY_SELECTION)}
      />
    ) : null;

  const toolbar = (
    <FileToolbar
      phone={phone}
      disabled={!listing}
      onUpload={upload}
      onNewFolder={() => {
        setRenaming(null);
        setCreating(true);
      }}
      terminalFolderKnown={state.cwd !== null}
      onTerminalFolder={() => void browser.goToTerminalFolder()}
      showHidden={showHidden}
      onToggleHidden={() => filePanes.update(paneId, sessionId, { showHidden: !showHidden })}
      onRefresh={browser.refresh}
      refreshing={state.loading && path !== null}
    />
  );
  const pathBar = (
    <FilePathBar
      path={available ? path : null}
      home={state.home}
      phone={phone}
      disabled={!listing}
      onNavigate={browser.navigate}
    />
  );

  return (
    <section
      aria-label={t('panelLabel', { label })}
      className={cx(
        '@container relative flex h-full min-h-0 w-full flex-col text-ink',
        phone ? 'bg-ground' : 'bg-ground-deep',
      )}
      {...drop.handlers}
    >
      {phone ? null : (
        <div className="flex h-10 shrink-0 items-center gap-2 border-line border-b ps-3.5 pe-1.5">
          <h2 className="font-semibold text-sm">{t('title')}</h2>
          <span className="min-w-0 truncate font-data text-ink-muted" title={target}>
            {target}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            title={t('close')}
            className={cx(
              'flex size-7 shrink-0 items-center justify-center rounded-sm text-ink-muted',
              'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-raised hover:text-ink',
              'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
            )}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      )}

      {/* Navigation always on top, then the actions, then what the selection can do. */}
      {pathBar}
      {toolbar}

      {deleting ? (
        <div
          role="status"
          className={cx(
            'flex shrink-0 items-center gap-2 rounded-control bg-surface-raised py-1.5 ps-3 pe-1.5 text-sm',
            phone ? 'mx-3 mb-2' : 'mx-2.5 mb-2',
          )}
        >
          <Spinner size={14} className="text-accent" />
          <span className="font-semibold">{t('delete.running')}</span>
          <span className="text-ink-muted tabular-nums">
            {t('delete.removed', { count: deleting.removed })}
          </span>
          <span className="flex-1" />
          <Button variant="quiet" size="sm" onClick={deleting.stop} className="h-7 px-2.5">
            {t('delete.stop')}
          </Button>
        </div>
      ) : null}

      {notices.length > 0 ? (
        <div className={cx('flex shrink-0 flex-col gap-2', phone ? 'mx-3 mb-2' : 'mx-2.5 mb-2')}>
          {notices.map((notice) => (
            <Notice key={notice.id} tone={notice.tone} title={notice.title} className="text-sm">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span>{notice.text}</span>
                <button
                  type="button"
                  className="font-semibold underline underline-offset-2"
                  onClick={() => dismiss(notice.id)}
                >
                  {t('dismiss')}
                </button>
              </span>
            </Notice>
          ))}
        </div>
      ) : null}

      {phone ? null : selectionBar}

      {body}

      {listing && !phone ? (
        <p className="shrink-0 border-line border-t px-4 py-1.5 text-ink-muted text-xs tabular-nums">
          {t('list.count', { count: visible.length })}
          {hidden > 0 && !showHidden ? ` · ${t('list.hiddenCount', { count: hidden })}` : ''}
          {state.truncated ? ` · ${t('list.truncated', { count: FILES_LIMITS.listEntries })}` : ''}
        </p>
      ) : null}
      {listing && phone && state.truncated ? (
        <p className="shrink-0 px-4 py-1.5 text-ink-muted text-xs">
          {t('list.truncated', { count: FILES_LIMITS.listEntries })}
        </p>
      ) : null}

      <TransferTray sessionId={sessionId} phone={phone} />
      {phone ? selectionBar : null}

      {drop.active && path ? <DropOverlay folder={path} /> : null}
      {confirmDelete ? (
        <DeleteDialog
          entries={confirmDelete}
          onConfirm={() => void runDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
      {pending ? (
        <ConflictDialog
          folder={baseName(pending.dir)}
          names={pending.conflicts}
          example={uniqueName(pending.conflicts[0] ?? '', (name) => pending.existing.has(name))}
          onChoose={(choice) => {
            setPending(null);
            enqueue(pending, choice);
          }}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </section>
  );
});
