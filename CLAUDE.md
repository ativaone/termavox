# Termdock

- Everything in the repository is in English: code, comments, docs and commit messages.
- Product and architecture decisions are the D-xx rows in `docs/implementation-plan.md`. A change
  that departs from one adds a new row that supersedes it, rather than silently diverging. Its §3
  glossary is the vocabulary: servers, credentials, sessions. Hosts and connection profiles are
  gone since D-29; keep the words out of code, UI copy and docs.
- Where the rest lives, updated in the same change: the visual system and component behaviour in
  `apps/web/DESIGN.md` (UI work goes through the vendored `impeccable` skill, D-19), users and
  purpose in `apps/web/PRODUCT.md`, operator procedures in `docs/guides/`, spike outcomes in
  `docs/adr/`, user-visible changes in `CHANGELOG.md` under `[Unreleased]`, and anything an
  existing install must do under its "Upgrade notes".
- Each verified functional block is committed and pushed to `origin main` (owner decision D-20,
  plan §16.2.1): the block's files by explicit path; subagents never commit. Verification is lean
  (D-21, plan §15): `pnpm check` always; `pnpm test:area <terminal|ssh|tmux>` when that area
  changed, which needs the test sshd containers (`docker compose -f test/sshd/compose.yaml up -d
  --build`, and `down` after); `pnpm test:release` before a release.
- `deploy/compose.yaml` pins the compose project name `termdock`: `docker compose -f
  deploy/compose.yaml` without `-p` acts on the machine's real install. Test stacks pass
  `-p termdock-smoke` or use `test/sshd/compose.yaml` (project `termdock-sshd`).
- Migrations are append-only: add one with `drizzle-kit generate`, never edit or regenerate an
  applied one. D-29's fresh `0000_init` was a one-off, before any install held data.
- In apps/web server code, match errors with `isTermdockError` / `isInternalApiError`, never
  `instanceof` alone: the auth runtime built in `instrumentation.ts` is another bundle layer with
  its own copies of the classes (a wrong setup token crashed `/setup` this way, only in the built
  app).
- Releases follow `docs/release-checklist.md`, including its screenshot step (the `ui-capture`
  skill).
