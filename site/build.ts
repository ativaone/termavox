/**
 * Builds the project site into site/dist (plan D-40): the hand-written pages of site/src with
 * the shared chrome filled in, the repository guides rendered from their Markdown, and the
 * repository's screenshots. Run with `pnpm --filter @termavox/site build`; the Pages workflow
 * publishes the result.
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDES, type Locale, SCREENSHOTS_DIR } from './lib/config.ts';
import { renderGuidePage } from './lib/guide-page.ts';
import { renderPage } from './lib/pages.ts';
import { sitemap } from './lib/seo.ts';

const SITE = dirname(fileURLToPath(import.meta.url));
const REPO = join(SITE, '..');

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'));
}

/** Builds the site into `out` (site/dist by default) and returns the output paths written. */
export async function build(out = join(SITE, 'dist')): Promise<string[]> {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const src = join(SITE, 'src');
  const sources = await files(src);
  const pages = new Set(sources.filter((p) => p.endsWith('.html')));
  const written: string[] = [];

  const write = async (path: string, content: string | Buffer) => {
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), content);
    written.push(path);
  };

  // Generated guides exist in English only; their other language is the docs index.
  const guidePaths = new Set(GUIDES.map((g) => `docs/${g.slug}/index.html`));
  const alternateOf = (path: string, locale: Locale): string | null => {
    if (locale === 'pt-BR') {
      const english = path.slice('pt-BR/'.length);
      return pages.has(english) ? english : null;
    }
    if (pages.has(`pt-BR/${path}`)) return `pt-BR/${path}`;
    return guidePaths.has(path) ? 'pt-BR/docs/index.html' : null;
  };

  for (const path of sources) {
    if (!path.endsWith('.html')) {
      await mkdir(dirname(join(out, path)), { recursive: true });
      await cp(join(src, path), join(out, path));
      written.push(path);
      continue;
    }
    const locale: Locale = path.startsWith('pt-BR/') ? 'pt-BR' : 'en';
    const html = await readFile(join(src, path), 'utf8');
    await write(path, renderPage(html, { locale, path, alternate: alternateOf(path, locale) }));
  }

  for (const guide of GUIDES) {
    const path = `docs/${guide.slug}/index.html`;
    const markdown = await readFile(join(REPO, guide.source), 'utf8');
    await write(path, renderGuidePage(guide, markdown, alternateOf(path, 'en')));
  }

  // Hand-written pages have a true translation; guides exist in English only.
  const listed = [...pages].map((path) => {
    const locale: Locale = path.startsWith('pt-BR/') ? 'pt-BR' : 'en';
    return { path, translation: alternateOf(path, locale) };
  });
  for (const path of guidePaths) listed.push({ path, translation: null });
  await write('sitemap.xml', sitemap(listed));

  for (const shot of await files(join(REPO, SCREENSHOTS_DIR))) {
    if (!shot.endsWith('.png')) continue;
    await write(`assets/screenshots/${shot}`, await readFile(join(REPO, SCREENSHOTS_DIR, shot)));
  }
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const written = await build();
  console.log(`site: ${written.length} files in site/dist`);
}
