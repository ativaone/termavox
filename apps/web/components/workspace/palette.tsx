'use client';

import type { SessionStatus } from '@termdock/protocol/client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SessionActionResult } from '../../lib/sessions/action-result.ts';
import { filterPalette } from '../../lib/workspace/palette.ts';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, SearchIcon } from '../icons/index.tsx';
import { cx } from '../ui/cx.ts';
import { Kbd } from '../ui/kbd.tsx';
import { Notice } from '../ui/notice.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { STATE_FILL } from '../ui/state.ts';
import { StatusChip } from '../ui/status-chip.tsx';

export interface PaletteSession {
  id: string;
  label: string;
  target: string;
  status: SessionStatus;
}

export interface PaletteProfile {
  id: string;
  name: string;
  username: string;
  hostName: string;
}

type Option =
  | { kind: 'session'; key: string; session: PaletteSession }
  | { kind: 'profile'; key: string; profile: PaletteProfile };

/**
 * The command palette (Ctrl/⌘K outside terminals, Ctrl+Shift+K inside): one search over open
 * sessions (jump to it) and connection profiles (start a session there). A combobox with a
 * grouped listbox, driven from the keyboard; it floats over the workspace without blocking it
 * (Escape or a click outside closes it, and the focus returns where it was).
 */
export function CommandPalette({
  sessions,
  profiles,
  hostsHref,
  onJump,
  onCreate,
  onClose,
}: {
  sessions: readonly PaletteSession[];
  profiles: readonly PaletteProfile[];
  hostsHref: string;
  onJump(sessionId: string): void;
  onCreate(profileId: string): Promise<SessionActionResult>;
  onClose(): void;
}) {
  const t = useTranslations('workspace.palette');
  const ts = useTranslations('workspace.status');
  const inputId = useId();
  const listId = useId();
  const sessionsHeading = useId();
  const profilesHeading = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const matchedSessions = useMemo(
    () => filterPalette(sessions, query, (s) => [s.label, s.target]),
    [sessions, query],
  );
  const matchedProfiles = useMemo(
    () => filterPalette(profiles, query, (p) => [p.name, `${p.username}@${p.hostName}`]),
    [profiles, query],
  );
  const options: Option[] = [
    ...matchedSessions.map((session) => ({
      kind: 'session' as const,
      key: `s-${session.id}`,
      session,
    })),
    ...matchedProfiles.map((profile) => ({
      kind: 'profile' as const,
      key: `p-${profile.id}`,
      profile,
    })),
  ];
  const activeIndex = options.length === 0 ? -1 : Math.min(index, options.length - 1);
  const active = activeIndex >= 0 ? options[activeIndex] : undefined;
  const optionId = (option: Option) => `${listId}-${option.key}`;

  // Focus in on open, back out on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // A click outside closes it.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  // Keep the active option in view.
  useEffect(() => {
    if (!active) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  });

  const choose = async (option: Option | undefined) => {
    if (!option || busy) return;
    if (option.kind === 'session') {
      onJump(option.session.id);
      return;
    }
    setBusy(option.key);
    setError(null);
    try {
      const result = await onCreate(option.profile.id);
      if (!result.ok) setError(result.message);
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = options.length;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown' && count > 0) {
      event.preventDefault();
      setIndex((activeIndex + 1) % count);
    } else if (event.key === 'ArrowUp' && count > 0) {
      event.preventDefault();
      setIndex((activeIndex - 1 + count) % count);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void choose(active);
    }
  };

  const row = (option: Option) => {
    const selected = option === active;
    const common = {
      id: optionId(option),
      role: 'option' as const,
      'aria-selected': selected,
      onPointerMove: () => setIndex(options.indexOf(option)),
      onClick: () => void choose(option),
    };
    const rowClass = cx(
      'grid min-h-11 cursor-pointer grid-cols-[4px_minmax(0,1fr)_auto] items-center gap-3 pe-3',
      selected ? 'bg-stock-followed' : 'bg-transparent',
    );
    if (option.kind === 'session') {
      const { session } = option;
      return (
        <li key={option.key} {...common} className={rowClass}>
          <span aria-hidden="true" className={cx('h-7', STATE_FILL[session.status])} />
          <span className="flex min-w-0 flex-col py-1">
            <span className="truncate font-semibold font-strip text-strip text-ink">
              {session.label}
            </span>
            <span className="truncate text-ink-muted text-xs">{session.target}</span>
          </span>
          <StatusChip status={session.status} label={ts(session.status)} />
        </li>
      );
    }
    const { profile } = option;
    return (
      <li key={option.key} {...common} className={rowClass}>
        <span aria-hidden="true" />
        <span className="flex min-w-0 items-center gap-2.5 py-1">
          <PlusIcon size={16} className="shrink-0 text-ink-muted" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-base text-ink">{profile.name}</span>
            <span className="truncate text-ink-muted text-xs">
              {profile.username}@{profile.hostName}
            </span>
          </span>
        </span>
        {busy === option.key ? (
          <span className="flex items-center gap-1.5 text-ink-muted text-xs">
            <Spinner size={14} />
            {t('starting')}
          </span>
        ) : selected ? (
          <span className="text-ink-muted text-xs">{t('start')}</span>
        ) : null}
      </li>
    );
  };

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex justify-center px-4 pt-[10vh] md:ps-[calc(var(--bay-width)+1rem)]">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('label')}
        className="surface-stock pointer-events-auto flex h-fit max-h-[80vh] w-full max-w-[36rem] flex-col overflow-hidden rounded-panel bg-stock text-ink shadow-panel"
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-rule border-b px-3.5">
          <SearchIcon size={18} className="shrink-0 text-ink-muted" />
          <label htmlFor={inputId} className="sr-only">
            {t('label')}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            readOnly={busy !== null}
            placeholder={t('placeholder')}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
              setError(null);
            }}
            onKeyDown={onKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-muted"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
          <div id={listId} role="listbox" aria-label={t('results')}>
            {matchedSessions.length > 0 ? (
              // biome-ignore lint/a11y/useSemanticElements: an option group of a listbox (a fieldset is not allowed there)
              <ul role="group" aria-labelledby={sessionsHeading}>
                <li
                  role="presentation"
                  id={sessionsHeading}
                  className="px-3.5 pt-1.5 pb-1 font-semibold text-ink-muted text-sm"
                >
                  {t('sessions')}
                </li>
                {options.filter((o) => o.kind === 'session').map(row)}
              </ul>
            ) : null}
            {matchedProfiles.length > 0 ? (
              // biome-ignore lint/a11y/useSemanticElements: an option group of a listbox (a fieldset is not allowed there)
              <ul
                role="group"
                aria-labelledby={profilesHeading}
                className={cx(matchedSessions.length > 0 && 'mt-1.5 border-rule border-t pt-1.5')}
              >
                <li
                  role="presentation"
                  id={profilesHeading}
                  className="px-3.5 pt-1.5 pb-1 font-semibold text-ink-muted text-sm"
                >
                  {t('newSession')}
                </li>
                {options.filter((o) => o.kind === 'profile').map(row)}
              </ul>
            ) : null}
          </div>
          {options.length === 0 ? (
            <p className="px-3.5 py-3 text-ink-muted text-base">
              {query.trim() ? t('noMatch', { query: query.trim() }) : t('nothing')}
            </p>
          ) : null}
          {profiles.length === 0 ? (
            <p className="border-rule border-t px-3.5 pt-3 pb-2 text-ink-muted text-sm">
              {t.rich('noProfiles', {
                link: (chunks) => (
                  <Link href={hostsHref} className="font-medium text-focus-stock underline">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          ) : null}
        </div>
        {error ? (
          <div className="shrink-0 px-3 pb-3">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-rule border-t px-3.5 py-2 text-ink-muted text-xs max-md:hidden">
          <span className="flex items-center gap-1">
            <Kbd>
              <ArrowUpIcon size={12} />
              <span className="sr-only">{t('keyUp')}</span>
            </Kbd>
            <Kbd>
              <ArrowDownIcon size={12} />
              <span className="sr-only">{t('keyDown')}</span>
            </Kbd>
            {t('hintMove')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd>
            {t('hintChoose')}
          </span>
        </div>
      </div>
    </div>
  );
}
