/** A repository guide as a site page: the shared chrome around its rendered Markdown. */

import { CHROME, type Guide, sourceUrl } from './config.ts';
import {
  bar,
  escapeHtml,
  foot,
  head,
  hrefTo,
  index,
  indexInline,
  type PageContext,
} from './layout.ts';
import { renderGuide } from './markdown.ts';
import { seoHead } from './seo.ts';

export function renderGuidePage(guide: Guide, markdown: string, alternate: string | null): string {
  const t = CHROME.en;
  const path = `docs/${guide.slug}/index.html`;
  const ctx: PageContext = { locale: 'en', path, alternate, section: 'docs' };
  const doc = renderGuide(markdown, guide.source, path);
  const editUrl = sourceUrl(guide.source).replace('/blob/', '/edit/');
  return `<!doctype html>
<html lang="en">
<head>
<title>${escapeHtml(doc.title)} · Termavox</title>
<meta name="description" content="${escapeHtml(doc.summary)}">
${head(ctx)}
${seoHead(path, {
  title: `${doc.title} · Termavox`,
  description: doc.summary,
  translation: null,
  kind: 'article',
  trail: [
    [t.docs, 'docs/index.html'],
    [doc.title, path],
  ],
})}
</head>
<body>
${bar(ctx)}
<div class="page">
  <main id="main" class="doc">
    <header class="head">
      <h1>${escapeHtml(doc.title)}</h1>
      <p class="provenance">${t.generatedFrom} <a href="${sourceUrl(guide.source)}" rel="noopener"><code>${escapeHtml(guide.source)}</code></a> · <a href="${editUrl}" rel="noopener">${t.editOnGitHub}</a> · <a href="${hrefTo(path, 'docs/index.html')}">${t.allDocs}</a></p>
      ${indexInline(ctx, doc.headings)}
    </header>
    <article class="prose">
${doc.html}
    </article>
  </main>
  ${index(ctx, doc.headings)}
</div>
${foot(ctx)}
</body>
</html>
`;
}
