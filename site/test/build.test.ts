import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from '../build.ts';
import { GUIDES, SITE_URL } from '../lib/config.ts';
import { resolveLink, slug } from '../lib/markdown.ts';
import { absoluteUrl } from '../lib/seo.ts';

const REPO = join(import.meta.dirname, '..', '..');
let out = '';
let pages = new Map<string, string>();

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'termavox-site-'));
  const written = await build(out);
  pages = new Map(
    written
      .filter((p) => p.endsWith('.html'))
      .map((p) => [p, readFileSync(join(out, p), 'utf8')] as const),
  );
});

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

function ids(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ''));
}

/** Every relative URL a page loads or links to. */
function references(html: string): string[] {
  return [...html.matchAll(/\s(?:href|src|srcset)="([^"]+)"/g)]
    .map((m) => (m[1] ?? '').replaceAll('&amp;', '&'))
    .filter((url) => !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//'));
}

describe('site build', () => {
  it('renders every guide under docs/guides', () => {
    const sources = new Set(GUIDES.map((g) => g.source));
    for (const file of readdirSync(join(REPO, 'docs/guides'))) {
      if (file.endsWith('.md')) expect(sources, file).toContain(`docs/guides/${file}`);
    }
  });

  it('fills every placeholder', () => {
    for (const [path, html] of pages) {
      expect(html, path).not.toMatch(/\{\{(head|bar|foot|root|index|index-inline)\}\}/);
    }
  });

  it('links only to pages, anchors and assets that exist', () => {
    const broken: string[] = [];
    for (const [path, html] of pages) {
      const folder = posix.dirname(path);
      for (const url of references(html)) {
        const hashAt = url.indexOf('#');
        const target = hashAt === -1 ? url : url.slice(0, hashAt);
        const anchor = hashAt === -1 ? '' : url.slice(hashAt + 1);
        let file = target === '' ? path : posix.normalize(posix.join(folder, target));
        if (target.endsWith('/') || target === '.' || target === './')
          file = posix.join(file, 'index.html');
        file = file.replace(/^\.\//, '');
        const exists = pages.has(file) || existsSync(join(out, file));
        if (!exists) {
          broken.push(`${path}: ${url}`);
          continue;
        }
        const svgSymbol = file.endsWith('.svg') && anchor;
        if (anchor && !svgSymbol && !ids(pages.get(file) ?? '').has(anchor)) {
          broken.push(`${path}: ${url} (no #${anchor})`);
        }
        if (svgSymbol && !readFileSync(join(out, file), 'utf8').includes(`id="${anchor}"`)) {
          broken.push(`${path}: ${url} (no symbol)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('lists every guide in both documentation indexes', () => {
    for (const hub of ['docs/index.html', 'pt-BR/docs/index.html']) {
      const linked = new Set(
        references(pages.get(hub) ?? '').map((url) =>
          posix.join(posix.normalize(posix.join(posix.dirname(hub), url)), 'index.html'),
        ),
      );
      for (const guide of GUIDES) expect(linked, hub).toContain(`docs/${guide.slug}/index.html`);
    }
  });
});

describe('search and link previews', () => {
  const meta = (html: string, attribute: string, name: string) =>
    new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"`).exec(html)?.[1];

  it('gives every page its canonical URL, a title, a description and a preview', () => {
    for (const [path, html] of pages) {
      expect(html, path).toContain(`<link rel="canonical" href="${absoluteUrl(path)}">`);
      expect(/<title>[^<]{10,}<\/title>/.test(html), `${path}: title`).toBe(true);
      expect(
        meta(html, 'name', 'description')?.length ?? 0,
        `${path}: description`,
      ).toBeGreaterThan(50);
      expect(meta(html, 'property', 'og:title'), path).toBeTruthy();
      expect(meta(html, 'property', 'og:image'), path).toMatch(new RegExp(`^${SITE_URL}/assets/`));
    }
  });

  it('carries the Search Console verification on the home page only', () => {
    const tag = '<meta name="google-site-verification"';
    for (const [path, html] of pages) {
      expect(html.includes(tag), path).toBe(path === 'index.html');
    }
  });

  it('writes structured data that parses', () => {
    for (const [path, html] of pages) {
      const blocks = [
        ...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
      ];
      expect(blocks.length, path).toBeGreaterThan(0);
      for (const block of blocks) expect(() => JSON.parse(block[1] ?? ''), path).not.toThrow();
    }
  });

  it('pairs each translation both ways', () => {
    for (const [path, html] of pages) {
      for (const m of html.matchAll(
        /<link rel="alternate" hreflang="(en|pt-BR)" href="([^"]+)">/g,
      )) {
        const other = [...pages].find(([p]) => absoluteUrl(p) === m[2]);
        expect(other, `${path} → ${m[2]}`).toBeDefined();
        expect(other?.[1], `${m[2]} → ${path}`).toContain(`href="${absoluteUrl(path)}"`);
      }
    }
  });

  it('lists every page in the sitemap', () => {
    const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(new Set(locs).size).toBe(locs.length);
    expect(new Set(locs)).toEqual(new Set([...pages.keys()].map(absoluteUrl)));
  });
});

describe('guide links', () => {
  it('keeps links between rendered guides on the site', () => {
    const page = 'docs/configuration/index.html';
    expect(resolveLink('install.md#upgrades', 'docs/guides/configuration.md', page)).toBe(
      '../../docs/install/#upgrades',
    );
    expect(resolveLink('../security.md', 'docs/guides/configuration.md', page)).toBe(
      '../../docs/security/',
    );
  });

  it('sends every other repository link to GitHub', () => {
    const page = 'docs/architecture/index.html';
    expect(
      resolveLink('implementation-plan.md#56-state-machine', 'docs/architecture.md', page),
    ).toBe(
      'https://github.com/ativaone/termavox/blob/main/docs/implementation-plan.md#56-state-machine',
    );
    expect(resolveLink('../../deploy/compose.yaml', 'docs/guides/configuration.md', page)).toBe(
      'https://github.com/ativaone/termavox/blob/main/deploy/compose.yaml',
    );
    expect(resolveLink('adr/', 'docs/architecture.md', page)).toBe(
      'https://github.com/ativaone/termavox/tree/main/docs/adr',
    );
  });

  it('slugs headings the way GitHub does', () => {
    expect(slug('5.12 File panel (D-39)')).toBe('512-file-panel-d-39');
    expect(slug('15 Testing strategy (lean, risk-based — D-21)')).toBe(
      '15-testing-strategy-lean-risk-based--d-21',
    );
    expect(slug('The "This Docker host" preset')).toBe('the-this-docker-host-preset');
  });
});
