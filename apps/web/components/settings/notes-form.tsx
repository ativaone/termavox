'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useId, useRef, useState } from 'react';
import { saveNotesPreferences } from '../../lib/actions/settings.ts';
import type { ManageState } from '../../lib/manage/forms.ts';
import {
  NOTE_AUTO_SWATCH,
  NOTE_FONT_SIZE_MAX,
  NOTE_FONT_SIZE_MIN,
  NOTE_FONTS,
  NOTE_PAPERS,
  type NoteFont,
  type NotePaper,
  type NotesPreferences,
  notePaperAttribute,
  noteTextLook,
} from '../../lib/preferences/notes.ts';
import { NoteIcon, TerminalIcon } from '../icons/index.tsx';
import { NOTE_TAB_RULE, noteTabFrame, noteTabLabel } from '../notes/note-tab-look.ts';
import { cx } from '../ui/cx.ts';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { choiceCardClasses, radioClasses } from '../ui/radio.ts';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';
import { useKeepChoicesOnReset } from '../ui/use-keep-choices.ts';

const SWATCH_FRAME = 'relative block h-9 overflow-hidden rounded-xs border border-line';

/** One theme's half of Automatic's swatch: its note page with two lines of ink. */
function AutoHalf({
  colors,
  className,
}: {
  colors: { note: string; ink: string; inkMuted: string };
  className?: string;
}) {
  return (
    <span
      className={cx('absolute inset-0 flex flex-col justify-center gap-1 px-2', className)}
      style={{ backgroundColor: colors.note }}
    >
      <span className="h-0.5 w-3/4 rounded-pill" style={{ backgroundColor: colors.ink }} />
      <span className="h-0.5 w-1/2 rounded-pill" style={{ backgroundColor: colors.inkMuted }} />
    </span>
  );
}

/**
 * A paper in small: its page with a line of ink and one of muted ink, drawn through the same
 * scope as a note. Automatic shows both interface themes, split on the diagonal.
 */
function PaperSwatch({ paper }: { paper: NotePaper }) {
  if (paper === 'auto') {
    return (
      <span aria-hidden="true" className={SWATCH_FRAME}>
        <AutoHalf colors={NOTE_AUTO_SWATCH.dark} />
        <AutoHalf
          colors={NOTE_AUTO_SWATCH.light}
          className="[clip-path:polygon(100%_0,100%_100%,0_100%)]"
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-note-paper={notePaperAttribute(paper)}
      className={cx(SWATCH_FRAME, 'flex flex-col justify-center gap-1 bg-note px-2')}
    >
      <span className="h-0.5 w-3/4 rounded-pill bg-ink" />
      <span className="h-0.5 w-1/2 rounded-pill bg-ink-muted" />
    </span>
  );
}

/**
 * A note in small: the pane's caption with the Terminal tab and an open note's tab, then the
 * note's page, through the same paper scope, tab look and text look as the workspace's notes.
 */
function Preview({
  paper,
  font,
  size,
  label,
}: {
  paper: NotePaper;
  font: NoteFont;
  size: number;
  label: string;
}) {
  const t = useTranslations('settings.notes');
  const tn = useTranslations('notes');
  const scope = notePaperAttribute(paper);
  const look = noteTextLook({ font, fontSize: size }, false);
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="font-semibold text-ink text-sm">{label}</figcaption>
      <div aria-hidden="true" className="overflow-hidden rounded-sm border border-line">
        <div className="pointer-events-none flex h-9 items-center gap-0.5 border-line border-b bg-surface px-1.5">
          <span className={noteTabFrame(false, false, 'terminal')}>
            <span className={noteTabLabel('terminal')}>
              <TerminalIcon size={14} className="shrink-0" />
              {tn('terminalTab')}
            </span>
          </span>
          <span className={NOTE_TAB_RULE} />
          <span data-note-paper={scope} className={noteTabFrame(true, false, 'note')}>
            <span className={cx(noteTabLabel('note'), 'pe-2')}>
              <NoteIcon size={14} className="shrink-0" />
              <span className="truncate">{t('sampleTitle')}</span>
            </span>
          </span>
        </div>
        <div data-note-paper={scope} className="bg-note text-ink">
          <p className={cx('whitespace-pre-wrap px-5 py-4', look.className)} style={look.style}>
            {t('sample')}
          </p>
        </div>
      </div>
    </figure>
  );
}

/**
 * How notes look (plan D-59), stored per user. The preview follows the form as it changes;
 * the workspace picks a saved change up the next time it loads.
 */
export function NotesForm({ initial }: { initial: NotesPreferences }) {
  const t = useTranslations('settings.notes');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(saveNotesPreferences, {} as ManageState);
  const formRef = useRef<HTMLFormElement>(null);
  useKeepChoicesOnReset(formRef);
  const [paper, setPaper] = useState<NotePaper>(initial.paper);
  const [font, setFont] = useState<NoteFont>(initial.font);
  const [size, setSize] = useState<number>(initial.fontSize);
  const fontHelpId = useId();
  const errorPrefix = tf('errorPrefix');

  return (
    <form ref={formRef} action={action} noValidate className="flex flex-col gap-6">
      <FormMessage message={state.message} />
      {state.notice ? <Notice tone="success">{state.notice}</Notice> : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 font-semibold text-ink text-sm">{t('paper')}</legend>
            <div className="grid grid-cols-2 gap-2">
              {NOTE_PAPERS.map((value) => (
                <label
                  key={value}
                  className={choiceCardClasses(paper === value, 'flex-col gap-2 p-2')}
                >
                  <input
                    type="radio"
                    name="paper"
                    value={value}
                    checked={paper === value}
                    onChange={() => setPaper(value)}
                    className="sr-only"
                  />
                  <PaperSwatch paper={value} />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-ink text-sm">
                      {t(`papers.${value}.name`)}
                    </span>
                    <span className="text-ink-muted text-sm">{t(`papers.${value}.hint`)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <fieldset className="flex flex-col gap-2" aria-describedby={fontHelpId}>
              <legend className="mb-1.5 font-semibold text-ink text-sm">{t('font')}</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {NOTE_FONTS.map((value) => (
                  <label key={value} className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="font"
                      value={value}
                      checked={font === value}
                      onChange={() => setFont(value)}
                      className={radioClasses()}
                    />
                    <span className="text-base text-ink">{t(`fonts.${value}`)}</span>
                  </label>
                ))}
              </div>
              <p id={fontHelpId} className="text-ink-muted text-sm">
                {t('fontHelp')}
              </p>
            </fieldset>
            <TextField
              name="fontSize"
              type="number"
              label={t('size')}
              help={t('sizeHelp', { min: NOTE_FONT_SIZE_MIN, max: NOTE_FONT_SIZE_MAX })}
              min={NOTE_FONT_SIZE_MIN}
              max={NOTE_FONT_SIZE_MAX}
              value={Number.isNaN(size) ? '' : size}
              onChange={(e) => setSize(Number.parseInt(e.target.value, 10))}
              error={state.fields?.fontSize}
              errorPrefix={errorPrefix}
              className="tabular-nums"
            />
          </div>
        </div>

        <Preview
          paper={paper}
          font={font}
          size={
            Number.isNaN(size)
              ? initial.fontSize
              : Math.min(Math.max(size, NOTE_FONT_SIZE_MIN), NOTE_FONT_SIZE_MAX)
          }
          label={t('preview')}
        />
      </div>

      <div className="border-line border-t pt-5">
        <SubmitButton size="lg">{t('submit')}</SubmitButton>
      </div>
    </form>
  );
}
