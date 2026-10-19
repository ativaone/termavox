/**
 * Repository Markdown → site HTML. Headings get GitHub's anchors (so `install.md#upgrades`
 * still lands), alerts become the site's notes, tables scroll in a card, links to another
 * rendered guide stay on the site and every other repository link goes to GitHub.
 */

import { posix } from 'node:path';
import { Marked, type Tokens } from 'marked';
import { CHROME, GUIDES, REPOSITORY_URL, sourceUrl } from './config.ts';
import { escapeHtml, hrefTo, type IndexItem, rootOf } from './layout.ts';

export interface RenderedGuide {
  /** The document's first H1, as plain text. */
  title: string;
  /** The first paragraph after the title, as plain text (the page description). */
  summary: string;
  /** Everything after the H1. */
  html: string;
  /** The H2s, for the page index. */
  headings: IndexItem[];
}

const ALERTS = {
  NOTE: { tone: 'info', icon: 'info' },
  TIP: { tone: 'tip', icon: 'tip' },
  IMPORTANT: { tone: 'info', icon: 'info' },
  WARNING: { tone: 'warning', icon: 'alert' },
  CAUTION: { tone: 'caution', icon: 'caution' },
} as const;

/** Plain text of rendered inline HTML. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .trim();
}

/** GitHub's heading anchor (github-slugger): lower case, punctuation dropped, spaces to dashes. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');
}

/**
 * Where a link in `source` (a repository path) points on the site: another guide's page when
 * it targets a rendered guide, GitHub otherwise. `page` is the output path being rendered.
 */
export function resolveLink(href: string, source: string, page: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
  if (href.startsWith('#')) return href;
  const hashAt = href.indexOf('#');
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const anchor = hashAt === -1 ? '' : href.slice(hashAt);
  const target = posix.normalize(posix.join(posix.dirname(source), path)).replace(/\/$/, '');
  const guide = GUIDES.find((g) => g.source === target);
  if (guide) return hrefTo(page, `docs/${guide.slug}/index.html`) + anchor;
  if (target.startsWith('..')) return href;
  const kind = /\.[a-z0-9]+$/i.test(target) ? 'blob' : 'tree';
  return kind === 'blob' ? sourceUrl(target, anchor) : `${REPOSITORY_URL}/tree/main/${target}`;
}

export function renderGuide(markdown: string, source: string, page: string): RenderedGuide {
  const t = CHROME.en;
  const root = rootOf(page);
  const seen = new Map<string, number>();
  const headings: IndexItem[] = [];
  let title = '';
  let summary = '';
  const icon = (name: string) =>
    `<svg class="icon" aria-hidden="true"><use href="${root}assets/icons.svg#${name}"/></svg>`;

  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const text = plainText(inner);
        if (depth === 1 && !title) {
          title = text;
          return '';
        }
        // Duplicates get GitHub's -1, -2 suffixes.
        const base = slug(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count}`;
        if (depth === 2) headings.push({ id, label: text });
        const anchor = `<a class="anchor" href="#${id}" aria-label="${t.sectionLink}">${icon('link')}</a>`;
        return `<h${depth} id="${id}">${inner}${anchor}</h${depth}>\n`;
      },
      paragraph({ tokens }) {
        const inner = this.parser.parseInline(tokens);
        if (title && !summary) summary = plainText(inner);
        return `<p>${inner}</p>\n`;
      },
      link({ href, title: linkTitle, tokens }) {
        const target = resolveLink(href, source, page);
        const external = /^https?:/.test(target);
        const titleAttr = linkTitle ? ` title="${escapeHtml(linkTitle)}"` : '';
        const rel = external ? ' rel="noopener"' : '';
        return `<a href="${escapeHtml(target)}"${titleAttr}${rel}>${this.parser.parseInline(tokens)}</a>`;
      },
      image({ href, title: imageTitle, text }) {
        const target = resolveLink(href, source, page).replace('/blob/', '/raw/');
        const titleAttr = imageTitle ? ` title="${escapeHtml(imageTitle)}"` : '';
        return `<img src="${escapeHtml(target)}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy">`;
      },
      code({ text, lang }) {
        if (lang === 'mermaid') {
          return `<aside class="note note-info">${icon('info')}<div class="note-body"><p>${t.diagram} <a href="${sourceUrl(source)}" rel="noopener">${t.viewDiagram}</a></p></div></aside>\n`;
        }
        const language = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
        return `<pre class="code"${language}><code>${escapeHtml(text)}</code></pre>\n`;
      },
      blockquote({ text }) {
        const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/.exec(text);
        if (!alert) return `<blockquote>${this.parser.parse(md.lexer(text))}</blockquote>\n`;
        const kind = ALERTS[alert[1] as keyof typeof ALERTS];
        const body = this.parser.parse(md.lexer(text.slice(alert[0].length)));
        return `<aside class="note note-${kind.tone}">${icon(kind.icon)}<div class="note-body">${body}</div></aside>\n`;
      },
      table(token: Tokens.Table) {
        const align = (i: number) => {
          const a = token.align[i];
          return a ? ` style="text-align:${a}"` : '';
        };
        const head = token.header
          .map((cell, i) => `<th${align(i)}>${this.parser.parseInline(cell.tokens)}</th>`)
          .join('');
        const rows = token.rows
          .map(
            (row) =>
              `<tr>${row.map((cell, i) => `<td${align(i)}>${this.parser.parseInline(cell.tokens)}</td>`).join('')}</tr>`,
          )
          .join('\n');
        return `<div class="table table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });

  const html = md.parse(markdown, { async: false });
  return { title, summary, html, headings };
}
