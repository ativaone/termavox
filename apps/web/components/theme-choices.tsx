'use client';

import { useTranslations } from 'next-intl';
import { ACCENT_FILL, THEME_SWATCHES, THEMES, type Theme } from '../lib/preferences/theme.ts';
import { cx } from './ui/cx.ts';
import { choiceCardClasses, radioClasses } from './ui/radio.ts';

/**
 * The three theme choices (plan D-55) as choice cards, each with a miniature of the interface in
 * that theme (System shows both, split on the diagonal). Shared by the theme dialog and the
 * account settings page; the form around it owns Apply.
 */
export function ThemeChoices({
  chosen,
  onChange,
}: {
  chosen: Theme;
  onChange: (theme: Theme) => void;
}) {
  const t = useTranslations('common.theme');
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{t('label')}</legend>
      {THEMES.map((value) => (
        <label
          key={value}
          className={choiceCardClasses(chosen === value, 'items-center gap-3 px-3 py-2.5')}
        >
          <input
            type="radio"
            name="theme"
            value={value}
            checked={chosen === value}
            onChange={() => onChange(value)}
            className={radioClasses()}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-base text-ink">{t(value)}</span>
            <span className="text-ink-muted text-sm">{t(`${value}Hint`)}</span>
          </span>
          <Miniature theme={value} />
        </label>
      ))}
    </fieldset>
  );
}

/** The interface in small: the ground, the sidebar with its lit button, and a card. */
function Miniature({ theme }: { theme: Theme }) {
  return (
    <span
      aria-hidden="true"
      className="relative h-9 w-14 shrink-0 overflow-hidden rounded-xs border border-line"
    >
      <Screen palette={theme === 'light' ? 'light' : 'dark'} />
      {theme === 'system' ? (
        <Screen palette="light" className="[clip-path:polygon(100%_0,100%_100%,0_100%)]" />
      ) : null}
    </span>
  );
}

function Screen({ palette, className }: { palette: 'dark' | 'light'; className?: string }) {
  const swatch = THEME_SWATCHES[palette];
  return (
    <span
      className={cx('absolute inset-0 flex gap-1 p-1', className)}
      style={{ backgroundColor: swatch.ground }}
    >
      <span className="flex w-3 flex-col gap-0.5 pt-0.5">
        <span className="h-1 rounded-pill" style={{ backgroundColor: ACCENT_FILL }} />
        <span className="h-0.5 rounded-pill opacity-60" style={{ backgroundColor: swatch.ink }} />
        <span className="h-0.5 rounded-pill opacity-60" style={{ backgroundColor: swatch.ink }} />
      </span>
      <span
        className="flex flex-1 flex-col gap-0.5 rounded-[3px] border p-1"
        style={{ backgroundColor: swatch.surface, borderColor: swatch.line }}
      >
        <span className="h-0.5 w-3/4 rounded-pill" style={{ backgroundColor: swatch.ink }} />
        <span
          className="h-0.5 w-1/2 rounded-pill opacity-60"
          style={{ backgroundColor: swatch.ink }}
        />
      </span>
    </span>
  );
}
