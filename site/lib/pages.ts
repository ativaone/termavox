/**
 * Fills a hand-written page's placeholders: {{head}}, {{bar}}, {{foot}}, {{root}}, and for
 * pages with sections, {{index}} and {{index-inline}} built from their `section.sec` headings
 * (each heading also gets its link to itself).
 */

import { CHROME } from './config.ts';
import {
  anchorLink,
  bar,
  foot,
  head,
  type IndexItem,
  index,
  indexInline,
  type PageContext,
  rootOf,
} from './layout.ts';
import { plainText } from './markdown.ts';
import { type PageMeta, seoHead } from './seo.ts';

const SECTION = /<section\b([^>]*)>(\s*)<h2>([\s\S]*?)<\/h2>/g;

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
}

/** The page's sections in order: id, heading text and index group. */
export function sectionsOf(html: string): IndexItem[] {
  const items: IndexItem[] = [];
  for (const match of html.matchAll(SECTION)) {
    const attributes = match[1] ?? '';
    const id = attribute(attributes, 'id');
    if (!id || !/\bclass="[^"]*\bsec\b/.test(attributes)) continue;
    items.push({
      id,
      label: plainText(match[3] ?? ''),
      group: attribute(attributes, 'data-group'),
    });
  }
  return items;
}

/** The page's own `<title>` and meta description. */
function metaOf(html: string): { title: string; description: string } {
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '';
  const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
  return { title: plainText(title), description: plainText(description) };
}

function pageMeta(html: string, ctx: PageContext): PageMeta {
  const { title, description } = metaOf(html);
  const prefix = ctx.locale === 'en' ? '' : `${ctx.locale}/`;
  const name = title.replace(/ · Termdock$/, '');
  const docs: [string, string] = [CHROME[ctx.locale].docs, `${prefix}docs/index.html`];
  const page = ctx.path.replace(/^pt-BR\//, '');
  const trail: [string, string][] =
    page === 'index.html'
      ? []
      : page === 'docs/index.html'
        ? [docs]
        : page.startsWith('docs/')
          ? [docs, [name, ctx.path]]
          : [[name, ctx.path]];
  return {
    title,
    description,
    translation: ctx.alternate,
    kind: page === 'index.html' ? 'home' : page.startsWith('docs/help/') ? 'article' : 'page',
    trail,
  };
}

function sectionOf(path: string): PageContext['section'] {
  const page = path.replace(/^pt-BR\//, '');
  if (page === 'index.html') return 'home';
  if (page.startsWith('docs/help/')) return 'help';
  if (page.startsWith('docs/')) return 'docs';
  return null;
}

export function renderPage(html: string, page: Omit<PageContext, 'section'>): string {
  const ctx: PageContext = { ...page, section: sectionOf(page.path) };
  const items = sectionsOf(html);
  const withAnchors = html.replace(SECTION, (whole, attributes: string, space, heading) => {
    const id = attribute(attributes, 'id');
    if (!id || !/\bclass="[^"]*\bsec\b/.test(attributes)) return whole;
    return `<section${attributes}>${space}<h2>${heading}${anchorLink(ctx, id)}</h2>`;
  });
  return withAnchors
    .replace('{{head}}', `${head(ctx)}\n${seoHead(ctx.path, pageMeta(html, ctx))}`)
    .replace('{{bar}}', bar(ctx))
    .replace('{{foot}}', foot(ctx))
    .replace('{{index}}', index(ctx, items))
    .replace('{{index-inline}}', indexInline(ctx, items))
    .replaceAll('{{root}}', rootOf(ctx.path));
}
