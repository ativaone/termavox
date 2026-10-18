---
name: ui-capture
description: Capture real screenshots of the Termdock web UI with headless Chromium against test SSH servers. Use when taking review screenshots of a UI change, refreshing docs/screenshots for a release (release checklist step 7), checking a screen visually at desktop and phone sizes, or scripting UI states (retry cards, host-key prompts, ended sessions) for a review page.
---

# UI capture sessions

`scripts/ui-capture.ts` runs everything a capture needs on private ports (default 3200-3202) and
cleans it up: the test sshd containers, session-manager with a throwaway `data/<name>-dev`, the
web app's production build, headless Chromium over CDP (`scripts/cdp.ts`), seeding through the
internal API, frames and screenshots. Write a short scene script that calls `runCapture()` and
keep it outside the repository (the session scratchpad); read the module's exports for the API.

## Running one

The whole run is one memory-capped process and the only heavy task running. Take about half of
the available memory as the cap, unless `CLAUDE.local.md` gives this machine's value:

```sh
trap 'docker compose -f test/sshd/compose.yaml down --timeout 15 >/dev/null 2>&1' EXIT
flock <scratchpad>/heavy.lock systemd-run --user --scope -q -p MemoryMax=<cap> -p MemorySwapMax=0 \
  node <scratchpad>/my-capture.ts
```

The trap matters only when the cap kills the run: the module stops the containers itself
otherwise. The flock serializes heavy steps between agents of one session. Two agents capturing
at once must not share `apps/web/.next`: `next build` inlines `NEXT_PUBLIC_TERMDOCK_WS_URL`, so
whoever builds last decides which daemon every page talks to.

## Rules that keep captures honest

- **Production build only.** `runCapture` builds and runs `next start`; `next dev` (Turbopack)
  beside the daemon and Chromium ran out of a 1500 MB cap at the first 2x shot. A cold build can
  be killed in its TypeScript step on a small machine; a second, warm run passes.
- **Default font hinting and at least one 1x desktop frame.** `--font-render-hinting=none` hid a
  word-spacing defect that only showed at 1x (`apps/web/DESIGN.md`, Typography → Rendering).
  `FRAMES` holds the release checklist sizes: desktop 1440×900 at 1x and 2x, phone 390×844 at 2x.
- **Real states, not mocks.** Drive the daemon through `c.api()` and the UI; check every scene
  with `c.check()` so a broken state fails the run instead of producing a misleading picture.
  `finish()` writes `console.json` (page errors) and `measurements.json` next to the images.
- **Locale.** Review captures use the reviewer's language; `docs/screenshots` uses `en`. Read
  labels from `apps/web/messages/*.json` instead of hard-coding them.

## Getting a session into a state

- **Connected:** a server on a test sshd port with `trust: true` (2201 has no tmux, 2202 tmux
  3.2a, 2203 tmux 3.4, 2204 the newest packaged tmux). `hostname: '<name>.localhost'` resolves to
  loopback and reads like a real address on screen.
- **Host-key prompt (Action required):** the same server without `trust`.
- **First-connection retry card, then Disconnected:** a port where nothing listens (`2299`): the
  connection is refused at once and the four attempts of D-31 run in about a minute.
- **Lost connection (Reconnecting until a deadline):** connect, then
  `c.compose(['stop', 'tmux-3.2a'])`; `c.compose(['start', 'tmux-3.2a'])` brings it back.
- **Ended:** `c.api('POST', '/sessions/<id>/terminate', { actingUserId: c.userId })`.
- **A fixed or changed server:** update its row with `c.db()` (web owns the `servers` table).
- **A tmux client attached on the server (D-30 leftovers):**
  `docker compose -f test/sshd/compose.yaml exec -d -T -u td <service> sh -c 'sleep 100000 | TERM=xterm-256color script -qfc "tmux -L <socket> attach -t main" /dev/null'`.
  Without TERM the attach fails; without the held-open stdin, EOF reaches the pane as Ctrl+D and
  the shell's exit ends the tmux session.

## Pitfalls

- **A page load replays only what the daemon replays.** A status field that only lives on the
  WebSocket (such as a retry round's attempt count) shows after a reload only because the daemon
  replays it to late clients; capture right after `navigate()` to prove that it does.
- **Phone frames of `/workspace?s=<id>` show the session list**, not the pane: on a phone the
  list is its own screen. Pane overlays need desktop frames, or a tap on the row first.
- **Native `<dialog>` forms submit only on an Enter that carries text** (`page.pressEnter()`,
  never a bare `Input.dispatchKeyEvent`). React `onKeyDown` handlers do not care.
- **Wait for hydration** (`page.waitHydrated`) before clicking anything React handles; a click on
  server-rendered markup does nothing.
- **Blur before a shot** (`c.blur()`), or a focus ring or tooltip lands in the picture.
