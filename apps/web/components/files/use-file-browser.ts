'use client';

import type { FileEntry } from '@termavox/protocol/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionFiles } from '../../lib/files/client.ts';
import { FileCode, fileErrorCode } from '../../lib/files/errors.ts';
import { nameCollator, sortEntries } from '../../lib/files/listing.ts';

/** Why the panel shows no listing: the server, the installation, or this folder. */
export type BrowserProblem =
  | { kind: 'sftp' }
  | { kind: 'disabled' }
  | { kind: 'error'; code: string; message: string };

export interface BrowserState {
  /** The user's home on the server (from `open`). */
  home: string | null;
  /** The terminal's folder at the last `open` (protected sessions only). */
  cwd: string | null;
  /** The folder on screen, canonical (links resolved by the daemon). */
  path: string | null;
  entries: FileEntry[];
  truncated: boolean;
  loading: boolean;
  problem: BrowserProblem | null;
}

const INITIAL: BrowserState = {
  home: null,
  cwd: null,
  path: null,
  entries: [],
  truncated: false,
  loading: false,
  problem: null,
};

/** A folder that cannot be listed falls back to home when the panel opens (plan §5.12). */
const FALL_BACK = new Set<string>([FileCode.NotFound, FileCode.PermissionDenied]);

function problemOf(err: unknown): BrowserProblem {
  const code = fileErrorCode(err);
  if (code === FileCode.SftpUnavailable) return { kind: 'sftp' };
  if (code === FileCode.FilesDisabled) return { kind: 'disabled' };
  return { kind: 'error', code, message: err instanceof Error ? err.message : code };
}

export interface FileBrowser {
  state: BrowserState;
  /** Lists `path`; a failure keeps the folder on screen and goes to `onError`. */
  navigate(path: string): Promise<boolean>;
  /** Lists the folder on screen again. */
  refresh(): void;
  /** Asks the daemon for the terminal's folder now and lists it. */
  goToTerminalFolder(): Promise<void>;
  /** Starts over: `open`, then the remembered folder, the terminal's, or home. */
  reload(): void;
  /** Puts a created or renamed entry in place without a round trip. */
  applyEntry(entry: FileEntry, replaces?: string): void;
}

/**
 * The listing behind one file panel: opens the session's files (home and the terminal's folder),
 * lists the remembered folder, the terminal's or home, and keeps the folder sorted (folders
 * first, natural order). Runs only while `available` (the session is connected); becoming
 * available again reloads it. Late answers of superseded loads are dropped.
 */
export function useFileBrowser({
  files,
  available,
  initialPath,
  locale,
  onPath,
  onError,
}: {
  files: SessionFiles;
  available: boolean;
  /** The pane's remembered folder (null the first time). */
  initialPath: string | null;
  locale: string;
  onPath(path: string): void;
  onError(code: string, message: string): void;
}): FileBrowser {
  const [state, setState] = useState<BrowserState>(INITIAL);
  const collator = useMemo(() => nameCollator(locale), [locale]);
  const seq = useRef(0);
  const latest = useRef({ files, initialPath, onPath, onError, collator, state });
  useEffect(() => {
    latest.current = { files, initialPath, onPath, onError, collator, state };
  });

  const show = useCallback((token: number, listed: Awaited<ReturnType<SessionFiles['list']>>) => {
    if (token !== seq.current) return;
    setState((previous) => ({
      ...previous,
      path: listed.path,
      entries: sortEntries(listed.entries, latest.current.collator),
      truncated: listed.truncated,
      loading: false,
      problem: null,
    }));
    latest.current.onPath(listed.path);
  }, []);

  const reload = useCallback(() => {
    const token = ++seq.current;
    const { files: api, state: current, initialPath: remembered } = latest.current;
    setState((previous) => ({ ...previous, loading: true }));
    void (async () => {
      let opened: Awaited<ReturnType<SessionFiles['open']>>;
      try {
        opened = await api.open();
      } catch (err) {
        if (token === seq.current) {
          setState((previous) => ({ ...previous, loading: false, problem: problemOf(err) }));
        }
        return;
      }
      if (token !== seq.current) return;
      setState((previous) => ({ ...previous, home: opened.home, cwd: opened.cwd }));
      const target = current.path ?? remembered ?? opened.cwd ?? opened.home;
      let failure: unknown;
      try {
        show(token, await api.list(target));
        return;
      } catch (err) {
        failure = err;
      }
      if (token !== seq.current) return;
      if (target !== opened.home && FALL_BACK.has(fileErrorCode(failure))) {
        try {
          show(token, await api.list(opened.home));
          return;
        } catch (err) {
          failure = err;
        }
      }
      if (token === seq.current) {
        setState((previous) => ({ ...previous, loading: false, problem: problemOf(failure) }));
      }
    })();
  }, [show]);

  const navigate = useCallback(
    async (path: string): Promise<boolean> => {
      const token = ++seq.current;
      setState((previous) => ({ ...previous, loading: true }));
      try {
        show(token, await latest.current.files.list(path));
        return true;
      } catch (err) {
        if (token !== seq.current) return false;
        const problem = problemOf(err);
        // With nothing listed yet, the failure is the panel's state; otherwise the folder on
        // screen stays and the failure is a notice.
        setState((previous) => ({
          ...previous,
          loading: false,
          problem: previous.path === null || problem.kind !== 'error' ? problem : previous.problem,
        }));
        if (problem.kind === 'error' && latest.current.state.path !== null) {
          latest.current.onError(problem.code, problem.message);
        }
        return false;
      }
    },
    [show],
  );

  const refresh = useCallback(() => {
    const path = latest.current.state.path;
    if (path === null) reload();
    else {
      const token = ++seq.current;
      setState((previous) => ({ ...previous, loading: true }));
      void latest.current.files.list(path).then(
        (listed) => show(token, listed),
        (err: unknown) => {
          if (token !== seq.current) return;
          setState((previous) => ({ ...previous, loading: false, problem: problemOf(err) }));
        },
      );
    }
  }, [reload, show]);

  const goToTerminalFolder = useCallback(async () => {
    try {
      const opened = await latest.current.files.open();
      setState((previous) => ({ ...previous, home: opened.home, cwd: opened.cwd }));
      if (opened.cwd) await navigate(opened.cwd);
    } catch (err) {
      const code = fileErrorCode(err);
      latest.current.onError(code, err instanceof Error ? err.message : code);
    }
  }, [navigate]);

  const applyEntry = useCallback((entry: FileEntry, replaces?: string) => {
    setState((previous) => {
      const rest = previous.entries.filter(
        (existing) => existing.name !== entry.name && existing.name !== replaces,
      );
      return { ...previous, entries: sortEntries([...rest, entry], latest.current.collator) };
    });
  }, []);

  // Load while available; coming back (the session reconnected) loads again.
  useEffect(() => {
    if (!available) {
      seq.current++; // answers of the old connection no longer count
      return;
    }
    reload();
  }, [available, reload]);

  return { state, navigate, refresh, goToTerminalFolder, reload, applyEntry };
}
