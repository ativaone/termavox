import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP_SECTIONS } from '../../apps/web/lib/links.ts';
import en from '../../apps/web/messages/en.json' with { type: 'json' };
import ptBR from '../../apps/web/messages/pt-BR.json' with { type: 'json' };
import type { Locale } from '../lib/config.ts';
import { plainText } from '../lib/markdown.ts';

/**
 * The user guide (plan D-40) against the app: both languages carry the same anchors, every
 * anchor the app links to exists, and the guide quotes every status, protection label,
 * failure message and end reason the UI can show, in the UI's own words. A new or reworded one
 * fails here until the guide explains it.
 */

const SRC = join(import.meta.dirname, '..', 'src');
const HELP: Record<Locale, string> = {
  en: 'docs/help/index.html',
  'pt-BR': 'pt-BR/docs/help/index.html',
};
const CATALOGS = { en, 'pt-BR': ptBR };
/** Wording for what has not shipped yet: the guide leaves it out (tmux compatibility mode, P7). */
const NOT_SHIPPED = new Set(['protection.tmux-normal']);
const QUOTED_GROUPS = ['status', 'protection', 'failure', 'endReason'] as const;

function read(locale: Locale): string {
  return readFileSync(join(SRC, HELP[locale]), 'utf8');
}

function anchors(html: string): string[] {
  const main = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? '';
  return [...main.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? '');
}

function words(html: string): string {
  return plainText(html).replaceAll('&nbsp;', ' ').replace(/\s+/g, ' ');
}

describe('user guide', () => {
  it('has the same anchors, in the same order, in both languages', () => {
    expect(anchors(read('pt-BR'))).toEqual(anchors(read('en')));
  });

  it('has every section the app links to', () => {
    for (const locale of ['en', 'pt-BR'] as const) {
      const ids = new Set(anchors(read(locale)));
      for (const section of HELP_SECTIONS) expect(ids, `${locale}: #${section}`).toContain(section);
    }
  });

  for (const locale of ['en', 'pt-BR'] as const) {
    it(`quotes every status and message the UI shows (${locale})`, () => {
      const text = words(read(locale));
      const { workspace } = CATALOGS[locale];
      const missing: string[] = [];
      for (const group of QUOTED_GROUPS) {
        const messages: Record<string, string> = workspace[group];
        for (const [key, value] of Object.entries(messages)) {
          if (NOT_SHIPPED.has(`${group}.${key}`)) continue;
          if (!text.includes(value)) missing.push(`workspace.${group}.${key}: ${value}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
