import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCENT_FILL,
  DEFAULT_THEME,
  isTheme,
  resolveTheme,
  THEME_SWATCHES,
} from '../lib/preferences/theme.ts';

const CSS = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

/** The declarations of the first rule whose selector line is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const end = CSS.indexOf('}', start);
  const body = CSS.slice(start + selector.length + 2, end);
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/^\s*([\w-]+):\s*([^;]+);/gm)) {
    declarations.set(match[1] as string, (match[2] as string).trim());
  }
  return declarations;
}

describe('theme choice (plan D-55)', () => {
  it('prefers the account, then the browser cookie, then System', () => {
    expect(DEFAULT_THEME).toBe('system');
    expect(resolveTheme({ userTheme: 'dark', cookieTheme: 'light' })).toBe('dark');
    expect(resolveTheme({ userTheme: null, cookieTheme: 'light' })).toBe('light');
    expect(resolveTheme({ userTheme: 'sepia', cookieTheme: 'nope' })).toBe('system');
    expect(resolveTheme({})).toBe('system');
    expect(isTheme('light')).toBe(true);
    expect(isTheme('auto')).toBe(false);
  });
});

describe('light palette in globals.css', () => {
  const dark = block('@theme static');
  const light = block(':root[data-theme="light"]');
  const system = block('  :root[data-theme="system"]');

  it('is the same for an explicit choice and for System on a light device', () => {
    expect([...system.entries()]).toEqual([...light.entries()]);
    expect(light.get('color-scheme')).toBe('light');
  });

  it('only redefines tokens the dark palette declares', () => {
    for (const name of light.keys()) {
      if (name === 'color-scheme' || name === '--scrollbar-thumb') continue;
      expect(dark.has(name), name).toBe(true);
    }
  });

  it('matches the swatches the browser bar and the theme miniatures use', () => {
    const tokens = { ground: 'ground', surface: 'surface', line: 'line', ink: 'ink-muted' };
    for (const [key, token] of Object.entries(tokens)) {
      const swatch = key as keyof typeof tokens;
      expect(THEME_SWATCHES.dark[swatch], `dark ${token}`).toBe(dark.get(`--color-${token}`));
      expect(THEME_SWATCHES.light[swatch], `light ${token}`).toBe(light.get(`--color-${token}`));
    }
    expect(dark.get('--color-accent-fill')).toBe(ACCENT_FILL);
    expect(light.has('--color-accent-fill')).toBe(false);
  });
});
