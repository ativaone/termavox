'use client';

import { useTranslations } from 'next-intl';
import {
  type KeyboardEvent,
  type RefCallback,
  useCallback,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import { NOTE_TITLE_MAX } from '../../lib/notes/limits.ts';
import { shownNoteId } from '../../lib/notes/pane-view.ts';
import { BellIcon, CloseIcon, NoteIcon, PlusIcon, TerminalIcon } from '../icons/index.tsx';
import { cx } from '../ui/cx.ts';
import type { PanePlace } from '../workspace/workspace-context.tsx';
import { useWorkspace } from '../workspace/workspace-context.tsx';
import {
  createNote,
  goToTerminal,
  openNote,
  requestDeleteNote,
  usePaneNotes,
  useSessionNotes,
} from './notes-toggle.tsx';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2';
const UNDERLINE =
  'after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-pill after:bg-accent';

/**
 * The Terminal tab lights like a workspace tab; a note's tab takes the note's own page colour with
 * a hairline, so the selected tab reads as the top of the page under it.
 */
function tabFrame(selected: boolean, phone: boolean, kind: 'terminal' | 'note'): string {
  return cx(
    'relative flex shrink-0 items-stretch rounded-sm',
    'transition-colors duration-(--duration-step) ease-(--ease-out)',
    phone ? 'h-11' : 'h-7',
    selected
      ? cx(
          'text-ink',
          kind === 'note'
            ? 'bg-note shadow-[inset_0_0_0_1px_var(--color-line-strong)]'
            : 'bg-surface-raised',
          UNDERLINE,
        )
      : 'text-ink-muted hover:bg-surface hover:text-ink',
  );
}

/** Scrolls the strip, and only the strip, just enough to show a tab. */
function reveal(strip: HTMLElement, tab: Element): void {
  const box = strip.getBoundingClientRect();
  const rect = tab.getBoundingClientRect();
  if (rect.left < box.left) strip.scrollLeft -= box.left - rect.left;
  else if (rect.right > box.right) strip.scrollLeft += rect.right - box.right;
}

/** The name of a note, being renamed in its tab: Enter or leaving saves, Escape cancels. */
function RenameField({
  title,
  label,
  phone,
  onCommit,
  onCancel,
}: {
  title: string;
  label: string;
  phone: boolean;
  onCommit(value: string, focusText: boolean): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(title);
  /** Enter or Escape closed it: the blur that follows must not save again. */
  const closed = useRef(false);
  const mount = useCallback<RefCallback<HTMLInputElement>>((element) => {
    if (element && document.activeElement !== element) {
      element.focus();
      element.select();
    }
  }, []);
  const finish = (focusText: boolean) => {
    if (closed.current) return;
    closed.current = true;
    onCommit(value, focusText);
  };
  return (
    <span className="flex items-center px-1">
      <input
        ref={mount}
        type="text"
        value={value}
        aria-label={label}
        maxLength={NOTE_TITLE_MAX}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            closed.current = true;
            onCancel();
          }
        }}
        onBlur={() => finish(false)}
        className={cx(
          'w-36 min-w-0 rounded-sm border border-accent bg-field px-1.5 font-semibold text-ink outline-none',
          // A phone zooms in on a field under 16 px.
          phone ? 'h-8 text-md' : 'h-6 text-sm',
        )}
      />
    </span>
  );
}

/**
 * The pane's tabs (plan D-58): Terminal, one per note, then "+". In the caption's middle slot on
 * the desktop; on a phone a 44 px row of note tabs under the header, which is its way back to the
 * terminal, where tapping the active tab renames (double-click isn't dependable on touch).
 */
export function NoteTabs({
  place,
  sessionId,
  label,
  bell = false,
  variant = 'pane',
}: {
  place: PanePlace;
  sessionId: string;
  /** The session's label. */
  label: string;
  /** A bell the user has not seen rang in this pane's terminal. */
  bell?: boolean;
  variant?: 'pane' | 'phone';
}) {
  const t = useTranslations('notes');
  const tw = useTranslations('workspace');
  const ws = useWorkspace();
  const { notes, paneNotes } = ws;
  const { paneId } = place;
  const phone = variant === 'phone';
  const session = useSessionNotes(sessionId);
  const state = usePaneNotes(paneId, sessionId);
  const on = state?.on ?? false;
  const shown = on ? shownNoteId(session.notes, state?.noteId) : null;
  const stripRef = useRef<HTMLDivElement>(null);
  const creating = useRef(false);

  // The active tab stays in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: shown, on and the number of tabs move it
  useEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector('[aria-selected="true"]')?.parentElement;
    if (strip && tab) reveal(strip, tab);
  }, [shown, on, session.notes.length]);

  // Arrows move along the tabs (the selected one is the tab stop); Enter or Space activates.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...(stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const current = tabs.indexOf(event.target as HTMLElement);
    if (current < 0) return;
    let next: number;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next]?.focus({ preventScroll: true });
    const frame = tabs[next]?.parentElement;
    if (stripRef.current && frame) reveal(stripRef.current, frame);
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    if (strip && event.deltaY !== 0 && event.deltaX === 0) strip.scrollLeft += event.deltaY;
  };
  const addNote = async () => {
    if (creating.current) return;
    creating.current = true;
    try {
      await createNote(ws, paneId, sessionId, (n) => t('defaultTitle', { n }));
    } finally {
      creating.current = false;
    }
  };

  return (
    <div className={'flex min-w-0 items-center gap-1'}>
      <div
        ref={stripRef}
        role="tablist"
        tabIndex={-1}
        aria-label={t('tabsLabel', { label })}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {phone ? null : (
          <div className={tabFrame(!on, false, 'terminal')}>
            <button
              type="button"
              role="tab"
              aria-selected={!on}
              tabIndex={on ? -1 : 0}
              onClick={() => goToTerminal(ws, paneId, sessionId)}
              className={cx(
                'flex items-center gap-1.5 rounded-sm px-2 font-semibold text-sm leading-4',
                FOCUS_RING,
              )}
            >
              <TerminalIcon size={14} className="shrink-0" />
              {t('terminalTab')}
              {bell ? <BellIcon size={14} className="shrink-0 text-attention" /> : null}
              {bell ? <span className="sr-only">{`, ${tw('tabs.bell')}`}</span> : null}
            </button>
          </div>
        )}
        {phone ? null : (
          // The terminal on one side, the notes on the other.
          <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-line-strong" />
        )}
        {session.notes.map((note) => {
          const selected = shown === note.id;
          if (state?.renaming === note.id) {
            return (
              <div key={note.id} className={tabFrame(selected, phone, 'note')}>
                <RenameField
                  title={note.title}
                  label={t('renameLabel', { title: note.title })}
                  phone={phone}
                  onCommit={(value, focusText) => {
                    const result = notes.rename(sessionId, note.id, value);
                    paneNotes.stopRename(paneId, sessionId, focusText);
                    if (result === 'invalid') {
                      paneNotes.setNotice(paneId, sessionId, 'titleInvalid');
                    }
                  }}
                  onCancel={() => paneNotes.stopRename(paneId, sessionId, true)}
                />
              </div>
            );
          }
          return (
            <div key={note.id} className={cx('group/tab', tabFrame(selected, phone, 'note'))}>
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                title={note.title}
                onClick={() => {
                  if (phone && selected) paneNotes.startRename(paneId, sessionId, note.id);
                  else openNote(ws, paneId, sessionId, note.id);
                }}
                onDoubleClick={() => {
                  if (!phone) paneNotes.startRename(paneId, sessionId, note.id);
                }}
                className={cx(
                  'flex min-w-0 max-w-44 items-center gap-1.5 rounded-sm ps-2 font-semibold text-sm leading-4',
                  FOCUS_RING,
                )}
              >
                <NoteIcon size={14} className="shrink-0" />
                <span className="truncate">{note.title}</span>
              </button>
              <button
                type="button"
                tabIndex={selected ? 0 : -1}
                onClick={() => requestDeleteNote(ws, paneId, sessionId, note.id)}
                aria-label={t('deleteLabel', { title: note.title })}
                title={t('delete')}
                className={cx(
                  'mx-1 flex size-5 shrink-0 items-center justify-center self-center rounded-xs text-ink-muted',
                  'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-pressed hover:text-ink',
                  FOCUS_RING,
                  !selected &&
                    (phone
                      ? 'hidden'
                      : 'opacity-0 focus-visible:opacity-100 group-hover/tab:opacity-100'),
                )}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        disabled={session.list !== 'ready'}
        onClick={() => void addNote()}
        aria-label={t('add')}
        title={t('add')}
        className={cx(
          'flex shrink-0 items-center justify-center rounded-sm text-ink-muted',
          'transition-colors duration-(--duration-step) ease-(--ease-out) hover:bg-surface-raised hover:text-ink',
          'disabled:text-ink-faint disabled:hover:bg-transparent',
          FOCUS_RING,
          phone ? 'size-11' : 'size-7',
        )}
      >
        <PlusIcon size={phone ? 20 : 16} />
      </button>
    </div>
  );
}
