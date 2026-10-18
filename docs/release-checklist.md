# Release checklist

The manual half of the pre-release routine ([plan §15.4](implementation-plan.md#154-pre-release-routine-d-25)).
Run it after `pnpm test:release` has passed on the release commit, and record the result in the
release notes or the delivery report.

1. **Automated routine.** `pnpm test:release` passed on this exact commit (T0, every T1 file,
   OSV scan, image builds, the smoke directly and behind a reverse proxy). Keep its summary table.
2. **Real phone.** On an actual phone (not emulation), sign in, open a session, type with the
   on-screen keyboard and the extra-key bar (Esc, Tab, Ctrl, Alt, arrows, paste), rotate the
   screen, lock the phone for a minute and come back: the session is still there.
3. **Both locales.** Switch en ↔ pt-BR (the corner control on the sign-in page; account menu →
   Language… once signed in); walk sign-in, the workspace, servers and admin pages in each; no
   untranslated or truncated text; the choice persists after signing out and in.
4. **Host-key mismatch.** Change the host key of a trusted test server (or point a server at
   another sshd): the session fails with the red mismatch alert and offers no in-flow accept;
   replacing the trusted key on the server page asks for the address and then connects.
5. **Keyboard-interactive / OTP host.** Against a host with keyboard-interactive or OTP
   sign-in: the prompt appears in the browser (secret answers masked), a correct answer
   connects, and after letting a prompt expire the next attempt prompts again.
6. **Backup → restore on a scratch install.** On a throwaway install (never a real one):
   `deploy/scripts/backup.sh`, change something (add a server), then
   `deploy/scripts/restore.sh --yes <backup>`: the change is gone, users, servers and sessions
   metadata are back, and a protected session resumes.
7. **Screenshots, when the UI changed significantly.** Refresh `docs/screenshots/` (the images
   its README and the project README show) from a real run (`scripts/ui-capture.ts`): desktop
   1440×900 at 1x, phone 390×844 at 2x, default font hinting. Otherwise optional: worth doing only when a capture run
   happens anyway.
8. **CHANGELOG and version.** `CHANGELOG.md` moves the release out of `[Unreleased]` with the
   date; the `version` fields match the tag; the upgrade notes mention anything operators must
   do.
9. **Tag.** Create the annotated tag `vX.Y.Z` on the tested commit and push it.
