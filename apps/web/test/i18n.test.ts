import { describe, expect, it } from 'vitest';
import { matchAcceptLanguage, resolveLocale } from '../i18n/locales.ts';
import en from '../messages/en.json' with { type: 'json' };
import ptBR from '../messages/pt-BR.json' with { type: 'json' };

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('message catalogs (plan §8.4)', () => {
  it('en and pt-BR have identical key sets', () => {
    const enKeys = keys(en).sort();
    const ptKeys = keys(ptBR).sort();
    expect(ptKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !ptKeys.includes(k))).toEqual([]);
  });

  it('has no empty messages', () => {
    for (const catalog of [en, ptBR]) {
      const empty = keys(catalog).filter((k) => {
        const value = k
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], catalog);
        return typeof value !== 'string' || value.trim() === '';
      });
      expect(empty).toEqual([]);
    }
  });
});

describe('locale resolution', () => {
  it('prefers the user, then the cookie, then Accept-Language, then English', () => {
    const header = 'pt-BR,pt;q=0.9,en;q=0.8';
    expect(resolveLocale({ userLocale: 'en', cookieLocale: 'pt-BR', acceptLanguage: header })).toBe(
      'en',
    );
    expect(resolveLocale({ userLocale: null, cookieLocale: 'pt-BR', acceptLanguage: 'en' })).toBe(
      'pt-BR',
    );
    expect(resolveLocale({ cookieLocale: 'fr', acceptLanguage: header })).toBe('pt-BR');
    expect(resolveLocale({ userLocale: 'de', acceptLanguage: 'de-DE,fr;q=0.5' })).toBe('en');
    expect(resolveLocale({})).toBe('en');
  });

  it('matches Accept-Language by q-value and primary subtag', () => {
    expect(matchAcceptLanguage('fr-FR, pt-PT;q=0.7, en;q=0.5')).toBe('pt-BR');
    expect(matchAcceptLanguage('pt;q=0.4, en-GB;q=0.8')).toBe('en');
    expect(matchAcceptLanguage('en;q=0, pt')).toBe('pt-BR');
    expect(matchAcceptLanguage('*')).toBeNull();
    expect(matchAcceptLanguage(null)).toBeNull();
  });
});
