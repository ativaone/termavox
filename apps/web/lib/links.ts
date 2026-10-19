import type { Locale } from '../i18n/locales.ts';

/**
 * Where the app links outside itself: the source repository and the project site (plan D-40),
 * which carries the documentation and the user guide in both languages. Browser-safe, so client
 * components share it. Both languages of the guide share the anchors below, and a test in
 * `site/test` checks them against the site.
 */
export const REPOSITORY_URL = 'https://github.com/ativaone/termdock';
export const SITE_URL = 'https://ativaone.github.io/termdock';

/** The user guide's sections, by their anchor on the help page. */
export const HELP_SECTIONS = [
  'essentials',
  'what-happens',
  'server-restarted',
  'protection',
  'linger',
  'own-tmux',
  'statuses',
  'reconnecting',
  'ending',
  'several-places',
  'workspace',
  'clipboard',
  'phone',
  'files',
  'files-sftp',
  'servers',
  'host-keys',
  'remote-sessions',
  'account',
  'messages',
] as const;
export type HelpSection = (typeof HELP_SECTIONS)[number];

/** The site's root for a locale: English at the top, the others under their tag. */
function siteRoot(locale: Locale): string {
  return locale === 'en' ? SITE_URL : `${SITE_URL}/${locale}`;
}

/** The documentation area of the site (the help button). */
export function docsUrl(locale: Locale): string {
  return `${siteRoot(locale)}/docs/`;
}

/** The user guide, at one of its sections when given ("Learn more" links). */
export function helpUrl(locale: Locale, section?: HelpSection): string {
  const page = `${siteRoot(locale)}/docs/help/`;
  return section ? `${page}#${section}` : page;
}
