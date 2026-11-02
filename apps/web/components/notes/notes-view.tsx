'use client';

import { useLocale, useTranslations } from 'next-intl';
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formatModified, formatSize } from '../../lib/files/format.ts';
import {
  NOTE_BODY_MAX_BYTES,
  NOTE_TITLE_MAX,
  NOTES_PER_SESSION_MAX,
} from '../../lib/notes/limits.ts';
import { shownNoteId } from '../../lib/notes/pane-view.ts';
import { type NoteState, noteCharacters } from '../../lib/notes/store.ts';
import { NoteIcon, PlusIcon } from '../icons/index.tsx';
import { Button } from '../ui/button.tsx';
import { cx } from '../ui/cx.ts';
import { DANGER_SLIP_CLASSES, Notice } from '../ui/notice.tsx';
import { Panel } from '../ui/panel.tsx';
import { useNow } from '../workspace/hooks.ts';
import { type PanePlace, useWorkspace } from '../workspace/workspace-context.tsx';
import { NoteTabs } from './note-tabs.tsx';
import {
  createNote,
  deleteNote,
  goToTerminal,
  useNote,
  usePaneNotes,
  useSessionNotes,
} from './notes-toggle.tsx';

/** "Copied" stays this long. */
const COPIED_MS = 1_500;
/** Past this share of the limit, the footer says how much is used. */
const LIMIT_WARNING = 0.9;

/** A text action inside a notice, in the notice's ink and weight. */
function NoticeAction({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button type="button" className="font-semibold underline underline-offset-2" onClick={onClick}>
      {children}
    </button>
  );
}

function NoticeBody({ text, children }: { text: ReactNode; children?: ReactNode }) {
  return (
    <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span>{text}</span>
      {children ? <span className="flex flex-wrap gap-x-3 gap-y-1">{children}</span> : null}
    </span>
  );
}

/** When a note was saved: the time alone today, the file panel's date convention before that. */
function savedTime(at: number, now: number, locale: string): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  return formatModified(at, now, locale);
}

function SaveStatus({ note }: { note: NoteState }) {
  const t = useTranslations('notes');
  const locale = useLocale();
  const now = useNow(60_000);
  let text: string;
  if (note.body !== 'ready') text = '';
  else if (note.save === 'saved') {
    text = t('save.saved', { time: savedTime(note.updatedAt, now, locale) });
  } else if (note.save === 'pending' || note.save === 'saving') text = t('save.saving');
  else if (note.save === 'retrying') text = t('save.retrying');
  else text = t('save.notSaved');
  return (
    <span role="status" className="min-w-0 truncate">
      {text}
    </span>
  );
}

function NoteFooter({
  note,
  paneId,
  sessionId,
  phone,
}: {
  note: NoteState;
  paneId: string;
  sessionId: string;
  phone: boolean;
}) {
  const t = useTranslations('notes');
  const { paneNotes } = useWorkspace();
  const characters = useMemo(() => noteCharacters(note.draft), [note.draft]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const ready = note.body === 'ready';
  const copy = () => {
    const refused = () => paneNotes.setNotice(paneId, sessionId, 'copyFailed');
    if (!navigator.clipboard?.writeText) {
      refused();
      return;
    }
    navigator.clipboard.writeText(note.draft).then(() => setCopied(true), refused);
  };
  const share = note.bytes / NOTE_BODY_MAX_BYTES;
  return (
    <div
      className={cx(
        'flex shrink-0 items-center gap-3 border-line border-t ps-5 pe-1 text-ink-muted text-xs',
        phone ? 'min-h-8 pb-[env(safe-area-inset-bottom)]' : 'h-8',
      )}
    >
      <SaveStatus note={note} />
      {ready ? (
        <span className="min-w-0 truncate tabular-nums @max-[24rem]:sr-only">
          {t('characters', { count: characters })}
          {share > LIMIT_WARNING
            ? ` · ${t('limitUsed', { percent: Math.floor(share * 100) })}`
            : ''}
        </span>
      ) : null}
      <span className="flex-1" />
      <Button variant="quiet" size="sm" disabled={!ready} onClick={copy} className="-my-px">
        {copied ? t('copied') : t('copy')}
      </Button>
    </div>
  );
}

/** What a note's saving needs to say: the note's own state, under the pane's notices. */
function SaveNotices({
  note,
  place,
  sessionId,
  canSaveAsNew,
}: {
  note: NoteState;
  place: PanePlace;
  sessionId: string;
  canSaveAsNew: boolean;
}) {
  const t = useTranslations('notes');
  const locale = useLocale();
  const ws = useWorkspace();
  const { notes, paneNotes } = ws;
  const { paneId } = place;
  const [loadFailed, setLoadFailed] = useState(false);
  const notices: ReactNode[] = [];
  if (note.save === 'conflict') {
    notices.push(
      <Notice key="conflict" tone="warning">
        <NoticeBody text={loadFailed ? t('conflict.loadFailed') : t('conflict.body')}>
          <NoticeAction
            onClick={() => {
              setLoadFailed(false);
              void notes.loadOther(sessionId, note.id).then((ok) => setLoadFailed(!ok));
            }}
          >
            {t('conflict.loadOther')}
          </NoticeAction>
          <NoticeAction onClick={() => notes.keepMine(sessionId, note.id)}>
            {t('conflict.keepMine')}
          </NoticeAction>
        </NoticeBody>
      </Notice>,
    );
  }
  if (note.save === 'gone') {
    notices.push(
      <Notice key="gone" tone="warning">
        <NoticeBody text={t('gone.body')}>
          {canSaveAsNew && note.draft !== '' ? (
            <NoticeAction
              onClick={() => {
                void notes.saveAsNew(sessionId, note.id).then((result) => {
                  if (result.ok) {
                    paneNotes.showNote(paneId, sessionId, result.id);
                    return;
                  }
                  const notice =
                    result.reason === 'limit'
                      ? 'limit'
                      : result.reason === 'signIn'
                        ? 'signIn'
                        : 'createFailed';
                  paneNotes.setNotice(paneId, sessionId, notice);
                });
              }}
            >
              {t('gone.saveNew')}
            </NoticeAction>
          ) : null}
        </NoticeBody>
      </Notice>,
    );
  }
  if (note.save === 'tooLarge') {
    notices.push(
      <Notice key="large" tone="danger">
        {t('tooLarge', { limit: formatSize(NOTE_BODY_MAX_BYTES, locale) })}
      </Notice>,
    );
  }
  if (note.save === 'signIn' || note.bodySignIn) {
    notices.push(
      <Notice key="signIn" tone="warning">
        {t('signIn')}
      </Notice>,
    );
  }
  if (note.titleRefused) {
    notices.push(
      <Notice key="title" tone="danger">
        {t('titleInvalid', { max: NOTE_TITLE_MAX })}
      </Notice>,
    );
  }
  if (note.body === 'failed' && !note.bodySignIn) {
    notices.push(
      <Notice key="body" tone="danger">
        <NoticeBody text={t('loadFailed')}>
          <NoticeAction onClick={() => notes.ensureBody(sessionId, note.id)}>
            {t('tryAgain')}
          </NoticeAction>
        </NoticeBody>
      </Notice>,
    );
  }
  if (notices.length === 0) return null;
  return <div className="flex shrink-0 flex-col gap-2 px-3 pt-3">{notices}</div>;
}

/** The note on screen: its notices, the text filling the space, the footer. */
function NoteEditor({
  place,
  sessionId,
  noteId,
  phone,
  canSaveAsNew,
}: {
  place: PanePlace;
  sessionId: string;
  noteId: string;
  phone: boolean;
  canSaveAsNew: boolean;
}) {
  const t = useTranslations('notes');
  const ws = useWorkspace();
  const { notes, paneNotes } = ws;
  const { paneId } = place;
  const note = useNote(sessionId, noteId);
  const state = usePaneNotes(paneId, sessionId);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const ready = note?.body === 'ready';
  const body = note?.body ?? 'idle';

  // biome-ignore lint/correctness/useExhaustiveDependencies: a failed body waits for Try again
  useEffect(() => {
    if (body === 'idle') notes.ensureBody(sessionId, noteId);
  }, [notes, sessionId, noteId]);

  // Going back to a note carries on where it was.
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!ready || !text) return;
    const caret = paneNotes.caret(paneId, noteId);
    if (!caret) return;
    text.setSelectionRange(caret.start, caret.end);
    text.scrollTop = caret.scrollTop;
  }, [ready, paneNotes, paneId, noteId]);

  const renaming = state?.renaming ?? null;
  const focusSeq = state?.focusSeq ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSeq re-checks a request made while this was mounted
  useEffect(() => {
    if (!ready || renaming || !paneNotes.takeTextFocus(paneId)) return;
    textRef.current?.focus({ preventScroll: true });
  }, [ready, renaming, focusSeq, paneNotes, paneId]);

  if (!note) return null;
  const remember = () => {
    const text = textRef.current;
    if (!text) return;
    paneNotes.saveCaret(paneId, noteId, {
      start: text.selectionStart,
      end: text.selectionEnd,
      scrollTop: text.scrollTop,
    });
  };
  return (
    <>
      <SaveNotices note={note} place={place} sessionId={sessionId} canSaveAsNew={canSaveAsNew} />
      {note.body === 'failed' ? (
        <div className="min-h-0 flex-1" />
      ) : (
        <textarea
          ref={textRef}
          value={note.draft}
          disabled={!ready}
          aria-label={t('textLabel', { title: note.title })}
          placeholder={ready ? t('placeholder') : t('loading')}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => notes.edit(sessionId, noteId, event.target.value)}
          onSelect={remember}
          onScroll={remember}
          onBlur={() => {
            remember();
            notes.flush(sessionId, noteId);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            goToTerminal(ws, paneId, sessionId);
          }}
          className={cx(
            'terminal-text block min-h-0 w-full flex-1 resize-none border-0 bg-transparent px-5 py-4 font-mono text-ink outline-none',
            'placeholder:text-ink-muted disabled:text-ink-muted',
            'focus:shadow-[inset_0_0_0_1px_var(--color-accent-ring)]',
            phone ? 'text-md' : 'text-base leading-[1.5]',
          )}
        />
      )}
      <NoteFooter note={note} paneId={paneId} sessionId={sessionId} phone={phone} />
    </>
  );
}

/** A session with no notes: what they are, what not to put in them, and the way to start. */
function EmptyNotes({ place, sessionId }: { place: PanePlace; sessionId: string }) {
  const t = useTranslations('notes');
  const ws = useWorkspace();
  const { paneNotes } = ws;
  const { paneId } = place;
  const titleId = useId();
  const state = usePaneNotes(paneId, sessionId);
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const focusSeq = state?.focusSeq ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSeq re-checks a request made while this was mounted
  useEffect(() => {
    if (paneNotes.takeTextFocus(paneId)) panelRef.current?.querySelector('button')?.focus();
  }, [focusSeq, paneNotes, paneId]);
  const create = async () => {
    setBusy(true);
    try {
      await createNote(ws, paneId, sessionId, (n) => t('defaultTitle', { n }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
      <Panel aria-labelledby={titleId} floating className="w-full max-w-[24rem]">
        <div ref={panelRef} className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <NoteIcon size={20} className="text-ink-muted" />
            <h2 id={titleId} className="font-semibold text-ink text-md">
              {t('empty.title')}
            </h2>
          </div>
          <p className="text-ink-muted text-base">{t('empty.body')}</p>
          <p className="text-ink-muted text-base">{t('empty.warning')}</p>
          <div>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              icon={<PlusIcon size={16} />}
              onClick={() => void create()}
            >
              {t('empty.create')}
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** "Delete this note?" at the top of the view: no modal, like the session menu's slips. */
function DeleteSlip({
  place,
  sessionId,
  noteId,
  title,
}: {
  place: PanePlace;
  sessionId: string;
  noteId: string;
  title: string;
}) {
  const t = useTranslations('notes');
  const ws = useWorkspace();
  const { paneNotes } = ws;
  const { paneId } = place;
  const titleId = useId();
  const slipRef = useRef<HTMLFieldSetElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => slipRef.current?.querySelector<HTMLElement>('[data-cancel]')?.focus(), []);
  const cancel = () => paneNotes.cancelDelete(paneId, sessionId);
  const onSlipKey = (event: { key: string; preventDefault(): void }) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cancel();
  };
  return (
    <div className="shrink-0 px-3 pt-3">
      <fieldset
        ref={slipRef}
        aria-labelledby={titleId}
        className={cx(DANGER_SLIP_CLASSES, 'm-0 min-w-0 border-0')}
      >
        <p id={titleId} className="text-pretty">
          {t('deleteQuestion', { title })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="destructive"
            size="sm"
            isolated={false}
            loading={busy}
            onKeyDown={onSlipKey}
            onClick={() => {
              setBusy(true);
              void deleteNote(ws, paneId, sessionId, noteId).finally(() => setBusy(false));
            }}
          >
            {t('deleteConfirm')}
          </Button>
          <Button data-cancel="" variant="quiet" size="sm" onKeyDown={onSlipKey} onClick={cancel}>
            {t('cancel')}
          </Button>
        </div>
      </fieldset>
    </div>
  );
}

/**
 * A session's notes over its pane's terminal (plan D-58): opaque, under the caption on the desktop
 * and full screen under its header on a phone. From the top: what needs saying, the text filling
 * the space, a footer. The note's name lives on its tab.
 */
export function NotesView({
  place,
  sessionId,
  label,
  variant = 'pane',
}: {
  place: PanePlace;
  sessionId: string;
  /** The session's label. */
  label: string;
  variant?: 'pane' | 'phone';
}) {
  const t = useTranslations('notes');
  const tw = useTranslations('workspace');
  const { notes, paneNotes, focusRequest, labels, onPaneFocus } = useWorkspace();
  const { paneId } = place;
  const phone = variant === 'phone';
  const session = useSessionNotes(sessionId);
  const state = usePaneNotes(paneId, sessionId);
  const noteId = shownNoteId(session.notes, state?.noteId);
  const title = session.notes.find((note) => note.id === noteId)?.title ?? null;

  useEffect(() => notes.ensureList(sessionId), [notes, sessionId]);
  useEffect(() => {
    if (noteId) paneNotes.remember(paneId, sessionId, noteId);
  }, [paneNotes, paneId, sessionId, noteId]);

  // The workspace sends the keyboard to this pane (a tab selected, a row followed): the text has it.
  const handled = useRef(0);
  useEffect(() => {
    if (!focusRequest || focusRequest.paneId !== paneId || handled.current === focusRequest.seq) {
      return;
    }
    handled.current = focusRequest.seq;
    paneNotes.requestTextFocus(paneId, sessionId);
  }, [focusRequest, paneNotes, paneId, sessionId]);

  const notice = state?.notice ?? null;
  const dismiss = () => paneNotes.setNotice(paneId, sessionId, null);
  let noticeText: string | null = null;
  if (notice === 'titleInvalid') noticeText = t('titleInvalid', { max: NOTE_TITLE_MAX });
  else if (notice === 'limit') noticeText = t('limit', { limit: NOTES_PER_SESSION_MAX });
  else if (notice === 'createFailed') noticeText = t('createFailed');
  else if (notice === 'deleteFailed') noticeText = t('deleteFailed');
  else if (notice === 'signIn') noticeText = t('signIn');
  else if (notice === 'copyFailed') noticeText = t('copyFailed');

  let body: ReactNode;
  if (noteId) {
    body = (
      <NoteEditor
        key={noteId}
        place={place}
        sessionId={sessionId}
        noteId={noteId}
        phone={phone}
        canSaveAsNew={labels.has(sessionId)}
      />
    );
  } else if (session.list === 'error') {
    body = (
      <div className="flex shrink-0 flex-col gap-2 px-3 pt-3">
        {session.listSignIn ? (
          <Notice tone="warning">{t('signIn')}</Notice>
        ) : (
          <Notice tone="danger">
            <NoticeBody text={t('listFailed')}>
              <NoticeAction onClick={() => notes.ensureList(sessionId)}>
                {t('tryAgain')}
              </NoticeAction>
            </NoticeBody>
          </Notice>
        )}
      </div>
    );
  } else if (session.list === 'ready') {
    body = <EmptyNotes place={place} sessionId={sessionId} />;
  } else {
    body = <p className="px-5 py-4 text-ink-muted text-sm">{t('loading')}</p>;
  }

  return (
    <div
      role="tabpanel"
      tabIndex={-1}
      aria-label={title ?? t('title')}
      onFocusCapture={() => onPaneFocus(place)}
      className="@container flex h-full min-h-0 w-full flex-col bg-ground-deep text-ink"
    >
      {phone && session.notes.length > 0 ? (
        <div className="flex shrink-0 border-line border-b px-1">
          <NoteTabs place={place} sessionId={sessionId} label={label} variant="phone" />
        </div>
      ) : null}
      {noticeText ? (
        <div className="shrink-0 px-3 pt-3">
          <Notice tone={notice === 'limit' || notice === 'signIn' ? 'warning' : 'danger'}>
            <NoticeBody text={noticeText}>
              <NoticeAction onClick={dismiss}>{tw('overlay.dismiss')}</NoticeAction>
            </NoticeBody>
          </Notice>
        </div>
      ) : null}
      {noteId && state?.deleting === noteId ? (
        <DeleteSlip
          key={`delete-${noteId}`}
          place={place}
          sessionId={sessionId}
          noteId={noteId}
          title={title ?? ''}
        />
      ) : null}
      {body}
    </div>
  );
}
