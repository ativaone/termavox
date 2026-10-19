/**
 * The project site (plan D-40): what it serves and where each part comes from. Hand-written
 * pages live in site/src; the guides are generated from the repository's Markdown at every
 * build, so the site never holds a second copy of them.
 */

export const REPOSITORY_URL = 'https://github.com/ativaone/termdock';
/** Where GitHub Pages serves the site (canonical URLs, the sitemap, link previews). */
export const SITE_URL = 'https://ativaone.github.io/termdock';
/** Google Search Console's ownership check for the URL-prefix property SITE_URL (home page only). */
export const GOOGLE_SITE_VERIFICATION = '_NiWrzBBGWJTqMM_wfMpYWAbRyDroAhu6pk6dogdQpE';
export const BRANCH = 'main';

export type Locale = 'en' | 'pt-BR';
export const LOCALES: readonly Locale[] = ['en', 'pt-BR'];

export interface Guide {
  /** Published at docs/<slug>/. */
  slug: string;
  /** Repository path of the Markdown source. */
  source: string;
}

/** Repository Markdown rendered as site pages (English only, like the repository's docs). */
export const GUIDES: readonly Guide[] = [
  { slug: 'install', source: 'docs/guides/install.md' },
  { slug: 'configuration', source: 'docs/guides/configuration.md' },
  { slug: 'architecture', source: 'docs/architecture.md' },
  { slug: 'security', source: 'docs/security.md' },
  { slug: 'changelog', source: 'CHANGELOG.md' },
];

/** Copied from the repository into the site's assets at build time. */
export const SCREENSHOTS_DIR = 'docs/screenshots';

/** The site chrome's words, per locale. */
export const CHROME = {
  en: {
    skip: 'Skip to content',
    siteNav: 'Site',
    docs: 'Docs',
    help: 'Help',
    language: 'Language',
    source: 'Source code on GitHub',
    sourceShort: 'GitHub',
    onThisPage: 'On this page',
    license: 'Free software under the AGPL-3.0 license.',
    install: 'Install',
    changelog: 'Changelog',
    generatedFrom: 'Generated from',
    editOnGitHub: 'Edit on GitHub',
    allDocs: 'All docs',
    sectionLink: 'Link to this section',
    diagram: 'This diagram is drawn on GitHub.',
    viewDiagram: 'View it in the source',
  },
  'pt-BR': {
    skip: 'Pular para o conteúdo',
    siteNav: 'Site',
    docs: 'Documentação',
    help: 'Ajuda',
    language: 'Idioma',
    source: 'Código-fonte no GitHub',
    sourceShort: 'GitHub',
    onThisPage: 'Nesta página',
    license: 'Software livre, sob a licença AGPL-3.0.',
    install: 'Instalação',
    changelog: 'Mudanças',
    generatedFrom: 'Gerado de',
    editOnGitHub: 'Editar no GitHub',
    allDocs: 'Toda a documentação',
    sectionLink: 'Link para esta seção',
    diagram: 'Este diagrama é desenhado no GitHub.',
    viewDiagram: 'Ver no código-fonte',
  },
} satisfies Record<Locale, Record<string, string>>;

export type Chrome = (typeof CHROME)['en'];

/** GitHub's page for a repository path, with an optional anchor. */
export function sourceUrl(path: string, anchor = ''): string {
  return `${REPOSITORY_URL}/blob/${BRANCH}/${path}${anchor}`;
}
