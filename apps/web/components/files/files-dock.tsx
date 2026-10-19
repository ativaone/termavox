'use client';

import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { PANEL_DEFAULT_WIDTH, panelGeometry } from '../../lib/files/pane-state.ts';
import { cx } from '../ui/cx.ts';
import { useWorkspace } from '../workspace/workspace-context.tsx';
import { FilePanel } from './file-panel.tsx';
import { useFilesAllowed, usePaneFiles } from './files-toggle.tsx';
import { PanelDivider } from './panel-divider.tsx';

/**
 * A desktop pane's body with its file panel (plan D-39): the terminal (`children`) and, while the
 * pane's toggle is on, the panel docked at the trailing edge behind a draggable divider. Docking
 * narrows the terminal's box, so the session resizes to it (this session only). When the pane
 * cannot keep a 320 px terminal beside a 300 px panel, the panel covers the terminal instead and
 * the terminal keeps its size, out of reach of the keyboard (`inert`) until the panel closes.
 */
export function FilesDock({
  paneId,
  sessionId,
  children,
}: {
  paneId: string;
  sessionId: string;
  children: ReactNode;
}) {
  const { filePanes, focusPane } = useWorkspace();
  const allowed = useFilesAllowed(sessionId);
  const state = usePaneFiles(paneId, sessionId);
  const open = allowed && (state?.open ?? false);
  const ref = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  // Stable, so dragging the divider (a width change here) never re-renders the panel.
  const close = useCallback(() => {
    filePanes.update(paneId, sessionId, { open: false });
    focusPane(paneId);
  }, [filePanes, focusPane, paneId, sessionId]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setPaneWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPaneWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const geometry = panelGeometry(paneWidth, state?.width ?? PANEL_DEFAULT_WIDTH);
  const docked = geometry.mode === 'dock';
  const covered = open && !docked;

  return (
    <div ref={ref} className="relative flex h-full w-full min-w-0">
      <div className="relative h-full min-w-0 flex-1" inert={covered}>
        {children}
      </div>
      {open ? (
        <>
          {docked ? (
            <PanelDivider
              width={geometry.width}
              max={geometry.max}
              onResize={(width) => filePanes.update(paneId, sessionId, { width })}
            />
          ) : null}
          <div
            className={cx('h-full', docked ? 'shrink-0' : 'absolute inset-0 z-30')}
            style={docked ? { width: geometry.width } : undefined}
          >
            <FilePanel paneId={paneId} sessionId={sessionId} variant="pane" onClose={close} />
          </div>
        </>
      ) : null}
    </div>
  );
}
