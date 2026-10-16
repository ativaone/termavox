'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { saveTerminalPreferences } from '../../lib/actions/settings.ts';
import type { ManageState } from '../../lib/manage/forms.ts';
import {
  CURSOR_STYLES,
  type CursorStyle,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  TERMINAL_FONT_STACKS,
  TERMINAL_FONTS,
  TERMINAL_SCHEMES,
  TERMINAL_THEMES,
  type TerminalFont,
  type TerminalPreferences,
  type TerminalScheme,
} from '../../lib/preferences/terminal.ts';
import { Checkbox } from '../ui/checkbox.tsx';
import { cx } from '../ui/cx.ts';
import { FormMessage, Notice } from '../ui/notice.tsx';
import { radioClasses } from '../ui/radio.ts';
import { Select } from '../ui/select.tsx';
import { SubmitButton } from '../ui/submit-button.tsx';
import { TextField } from '../ui/text-field.tsx';

/** A few lines of a shell, drawn with the chosen scheme, font and cursor (no terminal needed). */
function Preview({
  scheme,
  font,
  size,
  cursor,
  label,
}: {
  scheme: TerminalScheme;
  font: TerminalFont;
  size: number;
  cursor: CursorStyle;
  label: string;
}) {
  const theme = TERMINAL_THEMES[scheme];
  const cursorStyle =
    cursor === 'block'
      ? { background: theme.cursor, color: theme.cursorAccent }
      : cursor === 'bar'
        ? { boxShadow: `inset 2px 0 0 ${theme.cursor}` }
        : { boxShadow: `inset 0 -2px 0 ${theme.cursor}` };
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="font-semibold text-ink text-sm">{label}</figcaption>
      <div
        aria-hidden="true"
        className="overflow-x-auto rounded-[3px] px-3 py-2.5"
        style={{
          background: theme.background,
          color: theme.foreground,
          fontFamily: TERMINAL_FONT_STACKS[font],
          fontSize: `${size}px`,
          lineHeight: 1.35,
        }}
      >
        <div className="whitespace-pre">
          <span style={{ color: theme.green }}>deploy@api-1</span>:
          <span style={{ color: theme.blue }}>~/app</span>$ git status --short
        </div>
        <div className="whitespace-pre">
          <span style={{ color: theme.yellow }}> M</span> src/server.ts
        </div>
        <div className="whitespace-pre">
          <span style={{ color: theme.red }}>?? </span>
          <span style={{ color: theme.brightBlack }}>notes.txt</span>
        </div>
        <div className="whitespace-pre">
          <span style={{ color: theme.green }}>deploy@api-1</span>:
          <span style={{ color: theme.blue }}>~/app</span>$ <span style={cursorStyle}> </span>
        </div>
      </div>
    </figure>
  );
}

/**
 * Terminal preferences (plan §8.1 /settings/terminal), stored per user. The preview follows the
 * form as it changes; nothing applies to open terminals until saved.
 */
export function TerminalForm({ initial }: { initial: TerminalPreferences }) {
  const t = useTranslations('settings.terminal');
  const tf = useTranslations('common.field');
  const [state, action] = useActionState(saveTerminalPreferences, {} as ManageState);
  const [scheme, setScheme] = useState<TerminalScheme>(initial.colorScheme);
  const [font, setFont] = useState<TerminalFont>(initial.fontFamily);
  const [size, setSize] = useState<number>(initial.fontSize);
  const [cursor, setCursor] = useState<CursorStyle>(initial.cursorStyle);
  const errorPrefix = tf('errorPrefix');

  return (
    <form action={action} noValidate className="flex flex-col gap-6">
      <FormMessage message={state.message} />
      {state.notice ? <Notice tone="success">{state.notice}</Notice> : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 font-semibold text-ink text-sm">{t('scheme')}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {TERMINAL_SCHEMES.map((value) => {
                const theme = TERMINAL_THEMES[value];
                return (
                  <label
                    key={value}
                    className={cx(
                      'flex cursor-pointer flex-col gap-2 rounded-control border p-2',
                      'transition-colors duration-(--duration-step) ease-linear',
                      'has-focus-visible:outline-2 has-focus-visible:outline-focus has-focus-visible:outline-offset-2',
                      scheme === value
                        ? 'border-ink bg-stock-followed'
                        : 'border-rule-strong hover:bg-quiet-hover',
                    )}
                  >
                    <input
                      type="radio"
                      name="colorScheme"
                      value={value}
                      checked={scheme === value}
                      onChange={() => setScheme(value)}
                      className="sr-only"
                    />
                    <span
                      aria-hidden="true"
                      className="flex h-9 items-end gap-0.5 rounded-[2px] p-1.5"
                      style={{ background: theme.background }}
                    >
                      {[theme.foreground, theme.green, theme.yellow, theme.blue, theme.red].map(
                        (color) => (
                          <span
                            key={color}
                            className="h-2 flex-1 rounded-[1px]"
                            style={{ background: color }}
                          />
                        ),
                      )}
                    </span>
                    <span className="font-medium text-ink text-sm">{t(`schemes.${value}`)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <Select
              name="fontFamily"
              label={t('font')}
              help={t('fontHelp')}
              value={font}
              onChange={(e) => setFont(e.target.value as TerminalFont)}
              options={TERMINAL_FONTS.map((value) => ({ value, label: t(`fonts.${value}`) }))}
            />
            <TextField
              name="fontSize"
              type="number"
              label={t('size')}
              help={t('sizeHelp', { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX })}
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              value={Number.isNaN(size) ? '' : size}
              onChange={(e) => setSize(Number.parseInt(e.target.value, 10))}
              error={state.fields?.fontSize}
              errorPrefix={errorPrefix}
              className="tabular-nums"
            />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 font-semibold text-ink text-sm">{t('cursor')}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {CURSOR_STYLES.map((value) => (
                <label key={value} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="cursorStyle"
                    value={value}
                    checked={cursor === value}
                    onChange={() => setCursor(value)}
                    className={radioClasses()}
                  />
                  <span className="text-base text-ink">{t(`cursors.${value}`)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Checkbox name="cursorBlink" label={t('blink')} defaultChecked={initial.cursorBlink} />
        </div>

        <Preview
          scheme={scheme}
          font={font}
          size={
            Number.isNaN(size)
              ? initial.fontSize
              : Math.min(Math.max(size, FONT_SIZE_MIN), FONT_SIZE_MAX)
          }
          cursor={cursor}
          label={t('preview')}
        />
      </div>

      <fieldset className="flex flex-col gap-4 border-rule border-t pt-5">
        <legend className="float-left mb-1 w-full font-semibold text-ink text-md">
          {t('clipboard')}
        </legend>
        <Checkbox
          name="copyOnSelect"
          label={t('copyOnSelect')}
          help={t('copyOnSelectHelp')}
          defaultChecked={initial.copyOnSelect}
        />
        <Checkbox
          name="rightClickPaste"
          label={t('rightClickPaste')}
          help={t('rightClickPasteHelp')}
          defaultChecked={initial.rightClickPaste}
        />
        <Checkbox
          name="allowOsc52Write"
          label={t('osc52')}
          help={t('osc52Help')}
          defaultChecked={initial.allowOsc52Write}
        />
        <Checkbox
          name="confirmLinks"
          label={t('confirmLinks')}
          help={t('confirmLinksHelp')}
          defaultChecked={initial.confirmLinks}
        />
      </fieldset>

      <div className="border-rule border-t pt-5">
        <SubmitButton size="lg">{t('submit')}</SubmitButton>
      </div>
    </form>
  );
}
