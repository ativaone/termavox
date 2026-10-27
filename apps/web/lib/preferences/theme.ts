/**
 * The interface theme (plan D-55): the app's chrome only. Terminals keep their own colour scheme
 * (lib/preferences/terminal.ts), whatever the theme. Stored per user in `user_preferences.theme`
 * and mirrored in a cookie so pages without a session (sign-in, setup) open in the same theme.
 * Browser-safe: the theme dialog reads the same values.
 */

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Follows the operating system; where it says nothing, the page stays dark (globals.css). */
export const DEFAULT_THEME: Theme = 'system';
export const THEME_COOKIE = 'termavox-theme';
export const THEME_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** The signed-in user's stored theme wins; then this browser's cookie; then the default. */
export function resolveTheme({
  userTheme,
  cookieTheme,
}: {
  userTheme?: string | null;
  cookieTheme?: string | null;
}): Theme {
  if (isTheme(userTheme)) return userTheme;
  if (isTheme(cookieTheme)) return cookieTheme;
  return DEFAULT_THEME;
}

/**
 * A few colours of each palette, for what cannot read the CSS tokens: the browser's bar
 * (`theme-color`) and the miniatures of the theme choice, which show both palettes at once.
 * They mirror `--color-ground`, `--color-surface`, `--color-line` and `--color-ink-muted` in
 * globals.css (a test keeps them equal).
 */
export const THEME_SWATCHES = {
  dark: {
    ground: '#171431',
    surface: 'rgb(255 255 255 / 0.045)',
    line: 'rgb(255 255 255 / 0.09)',
    ink: '#aba7cb',
  },
  light: {
    ground: '#f3f1fa',
    surface: 'rgb(255 255 255 / 0.72)',
    line: 'rgb(23 20 49 / 0.1)',
    ink: '#565277',
  },
} as const;

/** The accent fill, the same in both palettes (`--color-accent-fill`). */
export const ACCENT_FILL = '#4cc9ff';
