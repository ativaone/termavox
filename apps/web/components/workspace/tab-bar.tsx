'use client';

import type { Tab, WorkspaceLayout } from '@termdock/protocol/client';
import { useTranslations } from 'next-intl';
import { type MouseEvent, type ReactNode, useRef } from 'react';
import type { SessionEntry } from '../../lib/terminal/index.ts';
import { findLeaf, leaves } from '../../lib/workspace/tree.ts';
import { BellIcon, CloseIcon, SplitDownIcon, SplitRightIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { STATE_FILL } from '../ui/state.ts';
import type { PaneMeta } from './workspace-context.tsx';

interface TabView {
  tab: Tab;
  label: string;
  title: string | null;
  session: SessionEntry | undefined;
  panes: number;
  bell: boolean;
}

function viewOf(
  tab: Tab,
  sessions: ReadonlyMap<string, SessionEntry>,
  paneMeta: Readonly<Record<string, PaneMeta>>,
  fallback: { empty: string; loading: string },
): TabView {
  const all = leaves(tab.root);
  const current = findLeaf(tab.root, tab.activePaneId) ?? all[0]!;
  const session = current.sessionId ? sessions.get(current.sessionId) : undefined;
  return {
    tab,
    label: session?.label ?? (current.sessionId ? fallback.loading : fallback.empty),
    title: paneMeta[current.id]?.title ?? null,
    session,
    panes: all.length,
    bell: all.some((leaf) => paneMeta[leaf.id]?.bell),
  };
}

/**
 * The slate tab bar: one tab per split tree, labelled by its focused pane's session (label, OSC
 * title, bell). The active tab is the buff one, joined to its pane by the pane's buff rule;
 * closing a tab only detaches. The split controls on the trailing edge act on the focused pane.
 */
export function TabBar({
  layout,
  sessions,
  paneMeta,
  onSelect,
  onClose,
  onSplit,
  canSplit,
  trailing,
}: {
  layout: WorkspaceLayout;
  sessions: ReadonlyMap<string, SessionEntry>;
  paneMeta: Readonly<Record<string, PaneMeta>>;
  onSelect(tabId: string): void;
  onClose(tabId: string): void;
  onSplit(direction: 'row' | 'column'): void;
  canSplit: boolean;
  trailing?: ReactNode;
}) {
  const t = useTranslations('workspace');
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const fallback = { empty: t('pane.emptyPane'), loading: t('pane.loading') };
  const views = layout.tabs.map((tab) => viewOf(tab, sessions, paneMeta, fallback));

  const close = (event: MouseEvent, index: number) => {
    const id = layout.tabs[index]!.id;
    // Keyboard users stay in the tab bar: the focus moves to the neighbouring tab.
    const neighbour = layout.tabs[index + 1] ?? layout.tabs[index - 1];
    onClose(id);
    if (event.detail === 0 && neighbour) {
      requestAnimationFrame(() => refs.current.get(neighbour.id)?.focus());
    }
  };

  return (
    <div className="flex h-(--tabbar-height) shrink-0 items-end gap-2 ps-1.5 pe-2">
      <nav aria-label={t('tabs.label')} className="flex min-w-0 flex-1 self-stretch">
        {views.length === 0 ? (
          <p className="self-center px-2 text-board-ink-muted text-xs">{t('tabs.empty')}</p>
        ) : (
          <ul className="flex min-w-0 items-end gap-1 overflow-x-auto [scrollbar-width:none]">
            {views.map((view, index) => {
              const active = view.tab.id === layout.activeTabId;
              const status = view.session?.status;
              return (
                <li
                  key={view.tab.id}
                  className={cx(
                    'flex h-8 min-w-28 max-w-60 shrink-0 items-stretch overflow-hidden rounded-t-[3px]',
                    'transition-colors duration-(--duration-step) ease-linear',
                    active
                      ? 'surface-stock bg-stock-followed text-ink'
                      : 'surface-board bg-board-3/55 text-board-ink-muted hover:bg-board-3 hover:text-board-ink',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cx('w-1 shrink-0', status ? STATE_FILL[status] : 'bg-board-rule')}
                  />
                  <button
                    ref={(element) => {
                      if (element) refs.current.set(view.tab.id, element);
                      else refs.current.delete(view.tab.id);
                    }}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelect(view.tab.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 ps-2.5 pe-1.5 text-start focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2"
                  >
                    <span className="min-w-0 truncate font-semibold font-strip text-strip">
                      {view.label}
                    </span>
                    {view.title ? (
                      <span
                        className={cx(
                          'min-w-0 flex-1 truncate text-xs',
                          active ? 'text-ink-muted' : 'text-board-ink-muted',
                        )}
                      >
                        {view.title}
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {view.panes > 1 ? (
                      <span
                        aria-hidden="true"
                        className={cx(
                          'shrink-0 rounded-[3px] px-1 font-semibold text-2xs tabular-nums',
                          active
                            ? 'bg-stock-pressed text-ink-muted'
                            : 'bg-board-1 text-board-ink-muted',
                        )}
                      >
                        {view.panes}
                      </span>
                    ) : null}
                    {view.bell ? <BellIcon size={14} className="shrink-0" /> : null}
                    <span className="sr-only">
                      {status ? `, ${t(`status.${status}`)}` : ''}
                      {view.panes > 1 ? `, ${t('tabs.panes', { count: view.panes })}` : ''}
                      {view.bell ? `, ${t('tabs.bell')}` : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => close(event, index)}
                    aria-label={t('tabs.closeLabel', { label: view.label })}
                    title={t('tabs.close')}
                    className={cx(
                      'flex w-7 shrink-0 items-center justify-center transition-colors duration-(--duration-step) ease-linear',
                      'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
                      active
                        ? 'text-ink-muted hover:bg-quiet-hover hover:text-ink'
                        : 'text-board-ink-muted hover:bg-board-rule hover:text-board-ink',
                    )}
                  >
                    <CloseIcon size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
      <div className="flex shrink-0 items-center gap-1 self-center">
        {trailing}
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          disabled={!canSplit}
          onClick={() => onSplit('row')}
          aria-label={t('tabs.splitRight')}
          title={t('tabs.splitRight')}
          icon={<SplitRightIcon size={16} />}
        />
        <Button
          variant="quiet"
          size="sm"
          iconOnly
          disabled={!canSplit}
          onClick={() => onSplit('column')}
          aria-label={t('tabs.splitDown')}
          title={t('tabs.splitDown')}
          icon={<SplitDownIcon size={16} />}
        />
      </div>
    </div>
  );
}
