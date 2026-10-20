# Termavox

- Everything in the repository is in English: code, comments, docs and commit messages. The
  pt-BR UI catalog and the site's pt-BR pages are the translations that ship.
- Product and architecture decisions are the D-xx rows in `docs/implementation-plan.md`. A change
  that departs from one adds a new row that supersedes it, rather than silently diverging. Its §3
  glossary is the vocabulary: servers, credentials, sessions. The host and connection-profile
  records are gone since D-29 (a server holds both); don't bring them back as entities, routes or
  UI copy. `hostname`, host keys (`known_host_keys`) and the Docker-host preset keep their names.
- Where the rest lives, updated in the same change: the visual system and component behaviour in
  `apps/web/DESIGN.md` (UI work goes through the vendored `impeccable` skill, D-19), users and
  purpose in `apps/web/PRODUCT.md`, operator procedures in `docs/guides/`, spike outcomes in
  `docs/adr/`, user-visible changes in `CHANGELOG.md` under `[Unreleased]`, and anything an
  existing install must do under its "Upgrade notes".
- The project site (`site/`, D-40) is part of the same change: the user help explains every
  user-visible behaviour, in English and pt-BR (`site/src/docs/help/`,
  `site/src/pt-BR/docs/help/`), and the home pages follow the README. The guides are rendered
  from `docs/` at build time. How the site works: the `site` skill; `site/test` guards the help
  against the UI's catalogs and the built site's links.
- Each verified functional block is committed and pushed to `origin main` (owner decision D-20,
  plan §16.2.1): the block's files by explicit path; subagents never commit. Verification is lean
  (D-21, plan §15): `pnpm check` always; when an area changed, its integration tests:
  `pnpm test:area <terminal|ssh|tmux>`, and for the `*.int.test.ts` files outside those areas
  (daemon, web terminal) `pnpm exec vitest run --project t1 <path>`. They need the test sshd
  containers (`docker compose -f test/sshd/compose.yaml up -d --build`, and `down` after).
  `pnpm test:release` runs before a release.
- `deploy/compose.yaml` pins the compose project name `termavox`: `docker compose -f
  deploy/compose.yaml` without `-p` acts on the machine's real install. Test stacks pass
  `-p termavox-smoke` or use `test/sshd/compose.yaml` (project `termavox-sshd`).
- Migrations are append-only: add one with `drizzle-kit generate`, never edit or regenerate an
  applied one. D-29's fresh `0000_init` was a one-off, before any install held data.
- In apps/web server code, match errors with `isTermavoxError` / `isInternalApiError`, never
  `instanceof` alone: the auth runtime built in `instrumentation.ts` is another bundle layer with
  its own copies of the classes (a wrong setup token crashed `/setup` this way, only in the built
  app).
- Releases follow `docs/release-checklist.md`, including its screenshot step (the `ui-capture`
  skill).
