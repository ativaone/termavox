'use client';

import type { SessionStatus } from '@termdock/protocol/client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SessionActionResult } from '../../lib/sessions/action-result.ts';
import { filterPalette } from '../../lib/workspace/palette.ts';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, SearchIcon } from '../icons/index.tsx';
import { cx } from '../ui/cx.ts';
import { CONTROL_BASE, CONTROL_SIZE_COMPACT } from '../ui/field.tsx';
import { Kbd } from '../ui/kbd.tsx';
import { Notice } from '../ui/notice.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { StateLamp, StatusChip } from '../ui/status-chip.tsx';

export interface PaletteSession {
  id: string;
  label: string;
  target: string;
  status: SessionStatus;
}

export interface PaletteServer {
  id: string;
  name: string;
  /** `user@host` (`:port` when not 22), or the local wording for a direct-mode server. */
  target: string;
}

type Option =
  | { kind: 'session'; key: string; session: PaletteSession }
  | { kind: 'server'; key: string; server: PaletteServer };

/**
 * The command palette (Ctrl/⌘K outside terminals, Ctrl+Shift+K inside): one search over open
 * sessions (jump to it) and servers (start a session there, plan D-29). A combobox with a
 * grouped listbox, driven from the keyboard; it floats over the workspace without blocking it
 * (Escape or a click outside closes it, and the focus returns where it was). Opaque: it may
 * sit over a live terminal.
 */
export function CommandPalette({
  sessions,
  servers,
  addServerHref,
  onJump,
  onCreate,
  onClose,
}: {
  sessions: readonly PaletteSession[];
  servers: readonly PaletteServer[];
  /** The Add server form, carrying the way back here (plan D-27). */
  addServerHref: string;
  onJump(sessionId: string): void;
  /** Starts a session from a server, with an optional name (empty: the server's name). */
  onCreate(serverId: string, label: string): Promise<SessionActionResult>;
  onClose(): void;
}) {
  const t = useTranslations('workspace.palette');
  const ts = useTranslations('workspace.status');
  const inputId = useId();
  const nameId = useId();
  const [name, setName] = useState('');
  const listId = useId();
  const sessionsHeading = useId();
  const serversHeading = useId();
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
  const matchedServers = useMemo(
    () => filterPalette(servers, query, (server) => [server.name, server.target]),
    [servers, query],
  );
  const options: Option[] = [
    ...matchedSessions.map((session) => ({
      kind: 'session' as const,
      key: `s-${session.id}`,
      session,
    })),
    ...matchedServers.map((server) => ({
      kind: 'server' as const,
      key: `v-${server.id}`,
      server,
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
      const result = await onCreate(option.server.id, name.trim());
      if (!result.ok) setError(result.message);
    } finally {
      setBusy(null);
    }
  };
  // Enter in the name field starts the highlighted server; Escape closes the palette.
  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void choose(active);
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
      'mx-1.5 grid min-h-11 cursor-pointer grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-control ps-2.5 pe-3',
      'transition-colors duration-(--duration-step) ease-(--ease-out)',
      selected
        ? 'bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-accent-ring)]'
        : 'bg-transparent',
    );
    if (option.kind === 'session') {
      const { session } = option;
      return (
        <li key={option.key} {...common} className={rowClass}>
          <StateLamp status={session.status} />
          <span className="flex min-w-0 flex-col py-1">
            <span className="truncate font-semibold text-ink text-sm">{session.label}</span>
            <span className="truncate text-ink-muted text-xs">{session.target}</span>
          </span>
          <StatusChip status={session.status} label={ts(session.status)} />
        </li>
      );
    }
    const { server } = option;
    return (
      <li key={option.key} {...common} className={rowClass}>
        <span aria-hidden="true" className="flex justify-center text-accent">
          <PlusIcon size={14} strokeWidth={2.25} />
        </span>
        <span className="flex min-w-0 flex-col py-1">
          <span className="truncate font-medium text-ink text-sm">{server.name}</span>
          <span className="truncate text-ink-muted text-xs">{server.target}</span>
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
    <div className="pointer-events-none fixed inset-0 z-50 flex justify-center px-4 pt-[10vh] md:ps-[calc(var(--sidebar-current,var(--sidebar-width))+1rem)]">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('label')}
        className="card-solid pointer-events-auto flex h-fit max-h-[80vh] w-full max-w-[36rem] flex-col overflow-hidden shadow-card"
      >
        <div className="flex h-13 shrink-0 items-center gap-2.5 border-line border-b px-4">
          <SearchIcon size={18} className="shrink-0 text-accent" />
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
            className="h-full min-w-0 flex-1 bg-transparent text-ink text-md outline-none placeholder:text-ink-muted"
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
                  className="px-4 pt-1.5 pb-1 font-semibold text-ink-muted text-xs"
                >
                  {t('sessions')}
                </li>
                {options.filter((o) => o.kind === 'session').map(row)}
              </ul>
            ) : null}
            {matchedServers.length > 0 ? (
              // biome-ignore lint/a11y/useSemanticElements: an option group of a listbox (a fieldset is not allowed there)
              <ul
                role="group"
                aria-labelledby={serversHeading}
                className={cx(matchedSessions.length > 0 && 'mt-1.5 border-line border-t pt-1.5')}
              >
                <li
                  role="presentation"
                  id={serversHeading}
                  className="px-4 pt-1.5 pb-1 font-semibold text-ink-muted text-xs"
                >
                  {t('newSession')}
                </li>
                {options.filter((o) => o.kind === 'server').map(row)}
              </ul>
            ) : null}
          </div>
          {options.length === 0 ? (
            <p className="px-4 py-3 text-base text-ink-muted">
              {query.trim() ? t('noMatch', { query: query.trim() }) : t('nothing')}
            </p>
          ) : null}
          {servers.length === 0 ? (
            <p className="border-line border-t px-4 pt-3 pb-2 text-ink-muted text-sm">
              {t.rich('noServers', {
                link: (chunks) => (
                  <Link
                    href={addServerHref}
                    className="font-medium text-accent underline decoration-accent/50 underline-offset-4 hover:decoration-accent"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          ) : null}
        </div>
        {active?.kind === 'server' ? (
          <div className="flex shrink-0 items-center gap-3 border-line border-t px-4 py-2.5">
            <label htmlFor={nameId} className="shrink-0 font-semibold text-ink text-sm">
              {t('name')}
            </label>
            <input
              id={nameId}
              type="text"
              value={name}
              placeholder={active.server.name}
              aria-describedby={`${nameId}-help`}
              maxLength={1024}
              autoComplete="off"
              spellCheck={false}
              readOnly={busy !== null}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={onNameKeyDown}
              className={cx(CONTROL_BASE, CONTROL_SIZE_COMPACT, 'flex-1')}
            />
            <span id={`${nameId}-help`} className="shrink-0 text-ink-muted text-xs max-sm:hidden">
              {t('nameHelp')}
            </span>
          </div>
        ) : null}
        {error ? (
          <div className="shrink-0 px-3 pb-3">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-line border-t px-4 py-2 text-ink-muted text-xs max-md:hidden">
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
