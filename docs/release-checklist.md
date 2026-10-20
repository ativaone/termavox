# Release checklist

How a release is cut ([plan §15.4](implementation-plan.md#154-pre-release-routine-d-25), D-41).
The images people install are built, tested and published by
[`.github/workflows/release.yml`](../.github/workflows/release.yml) when a `vX.Y.Z` or
`vX.Y.Z-rc.N` tag is pushed; this list is the manual half around it. Record the results in the
delivery report. A release is the owner's call (D-47): work happens on `develop`, a release
candidate is tagged there, and a final release fast-forwards `main` to `develop` and is tagged on
`main`, so `main` and the project site always show the latest final release.

Every release starts as a release candidate. The manual checks run against the candidate's
published images; when nothing but the version and the CHANGELOG changed after the candidate,
the final release needs only step 11.

## Before the candidate

1. **Automated routine.** The release workflow runs the whole `pnpm test:release` routine (T0,
   every T1 file, OSV scan, the smoke directly and behind a reverse proxy, file transfers
   included) against the exact images it is about to publish, before it pushes anything. Nothing
   runs on a push to `develop`, so a failure there costs a candidate number: when the candidate
   carries many changes, run CI on it first (`gh workflow run ci.yml --ref develop`, then
   `gh run watch`; its "Pre-release routine" job is the same routine). A local
   `pnpm test:release` is optional.
2. **Project site.** Read the user help (both languages) against `[Unreleased]` in the
   changelog: every user-visible change is explained, nothing unshipped is described. The home
   pages still match the README. Build it and look at the changed pages (the `site` skill); it
   goes live with the final release (step 11).
3. **Screenshots, when the UI changed significantly.** Refresh `docs/screenshots/` (the images
   its README and the project README show) from a real run (`scripts/ui-capture.ts`): desktop
   1440×900 at 1x, phone 390×844 at 2x, default font hinting. Otherwise optional: worth doing
   only when a capture run happens anyway.

## The candidate

4. **Version and tag.** `node scripts/set-version.ts X.Y.Z-rc.N` (every `package.json` and the
   image tags in `deploy/compose.yaml`), commit, push to `develop`, then create the annotated tag
   `vX.Y.Z-rc.N` on that commit and push it. Watch the Release workflow (`gh run watch`): every
   architecture in its `ARCHES` (amd64 only while arm64 is suspended, D-41) builds and passes its
   tests, the images are pushed, attested, and a GitHub prerelease appears with the image
   digests. Images reach the registry only after their tests pass, but a run that fails in its
   publish job can leave them there without a release. Either way, fix, and tag the next
   `-rc.N` (release tags cannot be moved or deleted).
5. **The published images.** The three packages under https://github.com/orgs/ativaone/packages
   are public (a package's first push can land private: Package settings → Change visibility);
   `gh attestation verify oci://ghcr.io/ativaone/termavox-web:X.Y.Z-rc.N --repo ativaone/termavox`
   passes, and the same for `termavox-session-manager` and `termavox-caddy`.

## On an install of the candidate's images

Install it as the installation guide says (check out the tag, `docker compose pull`, `up -d`)
on a throwaway install, or upgrade the trial install to it. Then:

6. **Real phone.** On an actual phone (not emulation), sign in, open a session, type with the
   on-screen keyboard and the extra-key bar (Esc, Tab, Ctrl, Alt, arrows, paste), rotate the
   screen, lock the phone for a minute and come back: the session is still there. Open the
   Files panel, upload a photo and download it back.
7. **Both locales.** Switch en ↔ pt-BR (the corner control on the sign-in page; account menu →
   Language… once signed in); walk sign-in, the workspace, servers and admin pages in each; no
   untranslated or truncated text; the choice persists after signing out and in. The account
   menu shows the candidate's version.
8. **Host-key mismatch.** Change the host key of a trusted test server (or point a server at
   another sshd): the session fails with the red mismatch alert and offers no in-flow accept;
   replacing the trusted key on the server page asks for the address and then connects.
9. **Keyboard-interactive / OTP host.** Against a host with keyboard-interactive or OTP
   sign-in: the prompt appears in the browser (secret answers masked), a correct answer
   connects, and after letting a prompt expire the next attempt prompts again.
10. **Backup → restore on a scratch install.** On a throwaway install (never a real one):
    `deploy/scripts/backup.sh`, change something (add a server), then
    `deploy/scripts/restore.sh --yes <backup>`: the change is gone, users, servers and sessions
    metadata are back, and a protected session resumes.

## The release

11. **CHANGELOG, version and tag.** On `develop`, `CHANGELOG.md` moves `[Unreleased]` to
    `## [X.Y.Z] - YYYY-MM-DD` (the workflow refuses a final release without it) and updates the
    compare links at the bottom; the upgrade notes mention anything operators must do.
    `node scripts/set-version.ts X.Y.Z`, commit and push. Then fast-forward `main` to it
    (`git push origin develop:main`; anything but a fast-forward is refused), wait for CI on
    `main` and for the Pages workflow (https://ativaone.github.io/termavox shows the new help and
    guides), then tag `vX.Y.Z` on that commit and push it. The workflow publishes `X.Y.Z`, `X.Y`
    and `latest` and the GitHub release; repeat step 5 for `X.Y.Z`.
