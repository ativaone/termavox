/**
 * What search engines and link previews read: the canonical URL, the language alternates, Open
 * Graph and Twitter cards, and schema.org data (JSON-LD). Every value comes from the page itself
 * (its title and description) or from the site config, never from a second copy.
 */

import { GOOGLE_SITE_VERIFICATION, type Locale, REPOSITORY_URL, SITE_URL } from './config.ts';
import { escapeHtml } from './layout.ts';

export interface PageMeta {
  title: string;
  description: string;
  /** The same content in the other language (an output path), for hreflang; null when none. */
  translation: string | null;
  kind: 'home' | 'article' | 'page';
  /** Breadcrumb trail after Home, as [name, output path]. */
  trail: [string, string][];
}

const IMAGE = {
  path: 'assets/screenshots/workspace.png',
  width: 1440,
  height: 900,
  alt: {
    en: 'The Termdock workspace: named sessions grouped by state, and a live shell',
    'pt-BR':
      'A área de trabalho do Termdock: sessões nomeadas agrupadas por estado e um shell ao vivo',
  },
};

const OG_LOCALE: Record<Locale, string> = { en: 'en_US', 'pt-BR': 'pt_BR' };
const HOME_NAME: Record<Locale, string> = { en: 'Home', 'pt-BR': 'Início' };

/** The absolute URL of an output path, folder-style for index pages. */
export function absoluteUrl(path: string): string {
  const folder = path.endsWith('index.html') ? path.slice(0, -'index.html'.length) : path;
  return `${SITE_URL}/${folder}`;
}

function localeOf(path: string): Locale {
  return path.startsWith('pt-BR/') ? 'pt-BR' : 'en';
}

function jsonLd(data: unknown): string {
  // `<` escaped so no string inside can close the script element.
  return `<script type="application/ld+json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`;
}

function structuredData(path: string, meta: PageMeta): unknown[] {
  const locale = localeOf(path);
  const url = absoluteUrl(path);
  const home = absoluteUrl(locale === 'en' ? 'index.html' : 'pt-BR/index.html');
  const data: unknown[] = [];
  if (meta.kind === 'home') {
    data.push({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'Termdock',
      description: meta.description,
      url,
      inLanguage: locale,
      applicationCategory: 'DeveloperApplication',
      applicationSubCategory: 'Web-based SSH terminal',
      operatingSystem: 'Linux (Docker Compose)',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      isAccessibleForFree: true,
      license: 'https://www.gnu.org/licenses/agpl-3.0.html',
      image: absoluteUrl(IMAGE.path),
      screenshot: absoluteUrl(IMAGE.path),
      softwareHelp: absoluteUrl(
        locale === 'en' ? 'docs/help/index.html' : 'pt-BR/docs/help/index.html',
      ),
      sameAs: [REPOSITORY_URL],
    });
    data.push({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Termdock',
      url: home,
      inLanguage: locale,
    });
    return data;
  }
  const trail: [string, string][] = [
    [HOME_NAME[locale], locale === 'en' ? 'index.html' : 'pt-BR/index.html'],
    ...meta.trail,
  ];
  data.push({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, target], i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name,
      item: absoluteUrl(target),
    })),
  });
  if (meta.kind === 'article') {
    data.push({
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: meta.title.replace(/ · Termdock$/, ''),
      description: meta.description,
      url,
      inLanguage: locale,
      isPartOf: { '@type': 'WebSite', name: 'Termdock', url: home },
      about: { '@type': 'SoftwareApplication', name: 'Termdock', url: home },
    });
  }
  return data;
}

/** The head tags for search and link previews of the page at `path`. */
export function seoHead(path: string, meta: PageMeta): string {
  const locale = localeOf(path);
  const url = absoluteUrl(path);
  const lines = [`<link rel="canonical" href="${url}">`];
  if (path === 'index.html' && GOOGLE_SITE_VERIFICATION) {
    lines.push(`<meta name="google-site-verification" content="${GOOGLE_SITE_VERIFICATION}">`);
  }
  if (meta.translation) {
    const english = locale === 'en' ? path : meta.translation;
    const portuguese = locale === 'pt-BR' ? path : meta.translation;
    lines.push(
      `<link rel="alternate" hreflang="en" href="${absoluteUrl(english)}">`,
      `<link rel="alternate" hreflang="pt-BR" href="${absoluteUrl(portuguese)}">`,
      `<link rel="alternate" hreflang="x-default" href="${absoluteUrl(english)}">`,
    );
  }
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const image = absoluteUrl(IMAGE.path);
  lines.push(
    `<meta property="og:site_name" content="Termdock">`,
    `<meta property="og:type" content="${meta.kind === 'home' ? 'website' : 'article'}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:locale" content="${OG_LOCALE[locale]}">`,
    ...(meta.translation
      ? [
          `<meta property="og:locale:alternate" content="${OG_LOCALE[locale === 'en' ? 'pt-BR' : 'en']}">`,
        ]
      : []),
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:width" content="${IMAGE.width}">`,
    `<meta property="og:image:height" content="${IMAGE.height}">`,
    `<meta property="og:image:alt" content="${escapeHtml(IMAGE.alt[locale])}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${image}">`,
    ...structuredData(path, meta).map(jsonLd),
  );
  return lines.join('\n');
}

/** sitemap.xml for the given output pages, with each page's language alternates. */
export function sitemap(pages: { path: string; translation: string | null }[]): string {
  const entries = pages.map(({ path, translation }) => {
    const links = translation
      ? [path, translation]
          .map(
            (p) =>
              `<xhtml:link rel="alternate" hreflang="${localeOf(p)}" href="${absoluteUrl(p)}"/>`,
          )
          .join('')
      : '';
    return `<url><loc>${absoluteUrl(path)}</loc>${links}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`;
}
