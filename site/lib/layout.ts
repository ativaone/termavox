/**
 * The chrome every site page shares (head, top bar, index, footer), filled into the
 * hand-written pages' placeholders and around the generated guides.
 */

import { CHROME, type Locale, REPOSITORY_URL } from './config.ts';

export interface PageContext {
  locale: Locale;
  /** Output path of the page, e.g. `pt-BR/docs/help/index.html`. */
  path: string;
  /** Where the language switch leads, as an output path (null: none). */
  alternate: string | null;
  /** Which top-bar entry is current. */
  section: 'home' | 'docs' | 'help' | null;
}

export interface IndexItem {
  id: string;
  /** Plain text. */
  label: string;
  /** Shown above the first item of each group. */
  group?: string | undefined;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Relative path from the page's folder to the site root (`''`, `'../'`, `'../../'`…). */
export function rootOf(path: string): string {
  return '../'.repeat(path.split('/').length - 1);
}

/** A link from one page to another output path, as a folder URL for index pages. */
export function hrefTo(from: string, to: string): string {
  const target = to.endsWith('index.html') ? to.slice(0, -'index.html'.length) : to;
  return rootOf(from) + target || './';
}

function localePrefix(locale: Locale): string {
  return locale === 'en' ? '' : `${locale}/`;
}

const GITHUB_MARK =
  '<svg class="mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="ROOTassets/icons.svg#github"/></svg>';

export function head(ctx: PageContext): string {
  const root = rootOf(ctx.path);
  const lines = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`,
    `<meta name="color-scheme" content="dark">`,
    `<meta name="theme-color" content="#171431">`,
    `<link rel="icon" href="${root}assets/icon.svg" type="image/svg+xml">`,
    `<link rel="preload" href="${root}assets/fonts/plus-jakarta-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>`,
    `<link rel="stylesheet" href="${root}assets/site.css">`,
    `<script src="${root}assets/site.js" defer></script>`,
  ];
  return lines.join('\n');
}

export function bar(ctx: PageContext): string {
  const t = CHROME[ctx.locale];
  const prefix = localePrefix(ctx.locale);
  const link = (to: string) => hrefTo(ctx.path, to);
  const current = (section: PageContext['section']) =>
    ctx.section === section ? ' aria-current="page"' : '';
  const english = ctx.locale === 'en' ? ctx.path : ctx.alternate;
  const portuguese = ctx.locale === 'pt-BR' ? ctx.path : ctx.alternate;
  const language = (locale: Locale, target: string | null, label: string, name: string) =>
    ctx.locale === locale
      ? `<span aria-current="true" lang="${locale}" title="${name}">${label}</span>`
      : target
        ? `<a href="${link(target)}" hreflang="${locale}" lang="${locale}" title="${name}" data-keep-hash>${label}</a>`
        : '';
  return `<a class="skip-link" href="#main">${t.skip}</a>
<header class="bar">
  <div class="bar-inner">
    <a class="brand" href="${link(`${prefix}index.html`)}"${current('home')}>
      <img src="${rootOf(ctx.path)}assets/icon.svg" alt="" width="28" height="28">
      <span class="brand-name">Termavox</span>
    </a>
    <nav class="bar-nav" aria-label="${t.siteNav}">
      <a href="${link(`${prefix}docs/index.html`)}"${current('docs')}>${t.docs}</a>
      <a href="${link(`${prefix}docs/help/index.html`)}"${current('help')}>${t.help}</a>
    </nav>
    <div class="bar-end">
      <nav class="langs" aria-label="${t.language}">
        ${language('en', english, 'EN', 'English')}
        ${language('pt-BR', portuguese, 'PT', 'Português (Brasil)')}
      </nav>
      <a class="source" href="${REPOSITORY_URL}" aria-label="${t.source}" title="${t.source}">
        ${GITHUB_MARK.replace('ROOT', rootOf(ctx.path))}<span class="source-label">${t.sourceShort}</span>
      </a>
    </div>
  </div>
</header>`;
}

export function foot(ctx: PageContext): string {
  const t = CHROME[ctx.locale];
  const prefix = localePrefix(ctx.locale);
  const link = (to: string) => hrefTo(ctx.path, to);
  return `<footer class="site-foot">
  <div class="site-foot-inner">
    <p class="site-foot-brand">
      <img src="${rootOf(ctx.path)}assets/icon.svg" alt="" width="20" height="20">
      <span><strong>Termavox</strong> · ${t.license}</span>
    </p>
    <nav aria-label="${t.siteNav}">
      <a href="${link(`${prefix}docs/index.html`)}">${t.docs}</a>
      <a href="${link(`${prefix}docs/help/index.html`)}">${t.help}</a>
      <a href="${link('docs/install/index.html')}">${t.install}</a>
      <a href="${link('docs/changelog/index.html')}">${t.changelog}</a>
      <a href="${REPOSITORY_URL}">${t.source}</a>
    </nav>
  </div>
</footer>`;
}

/** The index entries, grouped; the first is lit until site.js follows the reading. */
function indexList(items: readonly IndexItem[]): string {
  const first = items[0]?.id;
  const groups: { name: string | undefined; items: IndexItem[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && (item.group === undefined || item.group === last.name)) last.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }
  return groups
    .map((group) => {
      const name = group.name
        ? `<span class="index-group-name">${escapeHtml(group.name)}</span>`
        : '';
      const links = group.items
        .map(
          (item) =>
            `<li><a href="#${item.id}"${item.id === first ? ' aria-current="true"' : ''}>${escapeHtml(item.label)}</a></li>`,
        )
        .join('');
      const named = group.name ? ' index-group-named' : '';
      return `<div class="index-group${named}">${name}<ul>${links}</ul></div>`;
    })
    .join('\n');
}

/** The sticky index beside the content (wide screens). */
export function index(ctx: PageContext, items: readonly IndexItem[]): string {
  const t = CHROME[ctx.locale];
  return `<nav class="index" aria-label="${t.onThisPage}">
  <p class="index-title">${t.onThisPage}</p>
  <div class="index-list">${indexList(items)}</div>
</nav>`;
}

/** The same index folded under the title (narrow screens). */
export function indexInline(ctx: PageContext, items: readonly IndexItem[]): string {
  const t = CHROME[ctx.locale];
  return `<details class="index-inline">
  <summary>${t.onThisPage}<svg class="icon" aria-hidden="true"><use href="${rootOf(ctx.path)}assets/icons.svg#chevron-down"/></svg></summary>
  <nav class="index-list" aria-label="${t.onThisPage}">${indexList(items)}</nav>
</details>`;
}

/** A heading's link to itself, shown on hover and focus. */
export function anchorLink(ctx: PageContext, id: string): string {
  const t = CHROME[ctx.locale];
  return `<a class="anchor" href="#${id}" aria-label="${t.sectionLink}"><svg class="icon" aria-hidden="true"><use href="${rootOf(ctx.path)}assets/icons.svg#link"/></svg></a>`;
}
