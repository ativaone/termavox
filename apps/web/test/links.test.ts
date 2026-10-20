import { describe, expect, it } from 'vitest';
import { docsUrl, HELP_SECTIONS, helpUrl } from '../lib/links.ts';

describe('links to the project site (plan D-40)', () => {
  it('opens the documentation in the locale of the interface', () => {
    expect(docsUrl('en')).toBe('https://ativaone.github.io/termavox/docs/');
    expect(docsUrl('pt-BR')).toBe('https://ativaone.github.io/termavox/pt-BR/docs/');
  });

  it('opens the user guide, at a section when given', () => {
    expect(helpUrl('en')).toBe('https://ativaone.github.io/termavox/docs/help/');
    expect(helpUrl('pt-BR')).toBe('https://ativaone.github.io/termavox/pt-BR/docs/help/');
    expect(helpUrl('en', 'host-keys')).toBe(
      'https://ativaone.github.io/termavox/docs/help/#host-keys',
    );
    expect(helpUrl('pt-BR', 'files-sftp')).toBe(
      'https://ativaone.github.io/termavox/pt-BR/docs/help/#files-sftp',
    );
  });

  it('names every section of the guide once', () => {
    expect(new Set(HELP_SECTIONS).size).toBe(HELP_SECTIONS.length);
  });
});
