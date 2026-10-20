---
name: site
description: How the Termavox project site works (site/, GitHub Pages, plan D-40) and what to change there when the product changes. Use when editing the user help, the home pages or the documentation index, when a user-visible behaviour, status, message or setting changes, when the README, a guide in docs/ or the screenshots change, when adding a guide, or when building, previewing or publishing the site. Triggers: site, project site, GitHub Pages, help page, user guide, documentation area, Learn more link, help anchor, site/build.ts, pages.yml.
---

# The project site

Published by `.github/workflows/pages.yml` on every push to `main` that touches `site/`, `docs/`
or `CHANGELOG.md`, at https://ativaone.github.io/termavox. Its look is the app's
(`apps/web/DESIGN.md`); the page-level direction is `site/.impeccable/surfaces/site-help.md`.

## What lives where

| Part | Source | Languages |
|---|---|---|
| Home | `site/src/index.html`, `site/src/pt-BR/index.html` | en, pt-BR |
| Documentation index | `site/src/docs/index.html`, `site/src/pt-BR/docs/index.html` | en, pt-BR |
| User help | `site/src/docs/help/index.html`, `site/src/pt-BR/docs/help/index.html` | en, pt-BR |
| Guides | rendered from the Markdown listed in `GUIDES` (`site/lib/config.ts`) | en |
| Screenshots | copied from `docs/screenshots/` at build | — |

Hand-written pages carry placeholders the build fills (`{{head}}`, `{{bar}}`, `{{foot}}`,
`{{root}}`, `{{index}}`, `{{index-inline}}`); the help's index is built from its
`<section class="sec" id=… data-group=…>` headings. Chrome strings are `CHROME` in
`site/lib/config.ts`.

## What a change owes the site

- **A user-visible behaviour, status, message or setting** → the help, both languages, same
  anchors. Statuses, protection labels, failure messages and end reasons are quoted in the
  catalogs' exact words (`apps/web/messages/*.json`); `site/test/help.test.ts` fails until a new
  or reworded one is in both pages. Describe only what ships.
- **A help anchor the app links to** → `HELP_SECTIONS` in `apps/web/lib/links.ts` and the `id`
  in both pages, together; ids are stable English words shared by both languages.
- **A README change** (pitch, features, quick start, status) → both home pages.
- **A guide added under `docs/`** → `GUIDES` and both documentation indexes (the build test
  checks both). Edits to existing guides need nothing: they are rendered at every build.
- **New screenshots** → nothing to copy; check the home captions still match them.

## Search

Each page's `<title>` and meta description are its search result: write them for what people
type (persistent SSH in the browser, tmux, web SSH client, VPS or development server, an
alternative to Apache Guacamole for terminals), never as a keyword list. The build adds the
canonical URL, the hreflang pairs, Open Graph and Twitter cards and schema.org data
(`site/lib/seo.ts`), and writes `sitemap.xml`; `site/test/build.test.ts` checks all of it.
Named tools appear only where they help someone find Termavox, never in a comparison table.

## Build, test, preview

- `pnpm --filter @termavox/site build` writes `site/dist/` (gitignored).
- `site/test` runs in `pnpm check`: help parity and coverage, guide coverage, and a link checker
  over the built site (every relative link, asset and anchor must resolve).
- Preview: serve `site/dist` with any static server (`python3 -m http.server -d site/dist`);
  folder URLs need a server, `file://` does not resolve them. Captures for review go in
  `site/.impeccable/review/` (gitignored), desktop 1440 and phone 390 wide.

## Constraints

- No third-party requests: fonts are self-hosted with their OFL licenses, scripts are local
  progressive enhancements, every page works without JavaScript.
- New dependencies or Actions go through the dependency policy; the workflow pins official
  Actions by commit SHA.
