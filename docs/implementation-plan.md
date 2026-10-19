# Termdock — Implementation Plan

| | |
|---|---|
| **Status** | Draft v2 — review findings incorporated |
| **Date** | 2026-10-15 |
| **Inputs** | ChatGPT design conversation "Especificar sistema SSH persistente" (2 owner turns, read to the end) + decision session with the owner on 2026-10-15 + technical research (tmux control mode, stack versions) |
| **Scope** | MVP (v0.1.0) plus a recorded post-MVP roadmap |

**Revision history:** v1 2026-10-15 — initial draft · v2 2026-10-15 — critical-review findings incorporated, plus the owner's reduced test-image matrix (D-22).

---

## 0. How to read this document

- §1–§3 define the product, every decision taken so far, and the canonical vocabulary. **Read them first** — the rest of the plan depends on them.
- §4–§11 are the technical specification (architecture, session runtime, tmux integration, protocols, data model, security, UI).
- §12–§13 cover the repository, deployment and operations.
- §14 is the phased delivery plan, each phase with verifiable exit criteria.
- §15–§19 cover testing, how the work will be executed with `/ats-orchestrator`, risks, the post-MVP roadmap, and open items.
- Anything marked **[SPIKE]** is a design assumption that must be confirmed in Phase 0 before the dependent work starts.

---

## 1. Product definition

**Termdock is a persistent terminal-session runtime, accessible from the web.**

A Termdock instance holds SSH (and local) terminal sessions open on the server side, indefinitely, until the user explicitly ends them. Browsers are only *views* that attach to and detach from those sessions. Closing the browser, losing Wi-Fi, switching from laptop to phone — none of it affects the session. When the user comes back, the terminal is as it was: same screen, same cursor, same colors, same scrollback, same `vim` or `htop` still running (fidelity limits in §5.3.1).

Founding principle (from the design conversation):

> **browser lifecycle ≠ terminal lifecycle**

It is conceptually close to Apache Guacamole, but structured differently: SSH only, and the core of the product is the *persistent session manager*, not a protocol gateway. The web UI is just one way to attach to sessions.

### 1.1 MVP goals

| ID | Goal |
|---|---|
| G1 | Sessions survive browser close/reopen. Reattach restores the terminal state instantly — exact for buffer, cursor and the tracked modes (§5.3.1), including alternate-screen apps such as `vim`, `htop`, `less`. |
| G2 | Sessions survive Termdock restarts and network drops when protected by tmux — which is automatic by default — and the recovery is **invisible** to the user (a brief "Restoring…" at most). |
| G3 | Multi-user with strict isolation, run as a hardened, privileged bastion. |
| G4 | A workspace UI with a session sidebar, tabs and split panes. The layout is restored from any browser, and the UI is usable from a phone. |
| G5 | One-command deployment (`docker compose up`) with automatic TLS. |

### 1.2 MVP non-goals

Other protocols (RDP/VNC); Agent mode (outbound agent on target servers); RBAC and sharing hosts/sessions between users; terminal recording; HA/multi-instance; jump hosts (ProxyJump); SSH agent forwarding; SSO/OIDC; passkeys. All of these are in the roadmap (§18). File transfer left this list with D-39 (§5.12).

---

## 2. Decision log

### 2.1 Owner decisions (binding)

| ID | Decision | Origin |
|---|---|---|
| D-01 | SSH only, plus a "local" mode for when Termdock runs on the target server itself. | Conversation |
| D-02 | Sessions are owned by the server, never by the browser. The browser attaches and detaches. | Conversation |
| D-03 | **Server-side terminal emulator** ("Strategy B") is the authority over visual state. `xterm.js` in the browser is a renderer and input collector, never a source of truth. | Conversation (owner, turn 2) |
| D-04 | tmux-compatible. When tmux is used, recovery must be invisible: "the user should not even notice". | Conversation (owner, turns 1–2) |
| D-05 | SQLite as the database for now. The persistence layer stays decoupled so it can move to PostgreSQL later. | Conversation (owner, turn 2) |
| D-06 | Product name: **Termdock**. | Owner (repository name) |
| D-07 | Process model: **Next.js (control plane) + a separate Node.js daemon `session-manager` (data plane)**, in a pnpm monorepo. A future evolution must be recorded: **daemon + one worker process per session** (§18.1). | Owner, 2026-10-15 |
| D-08 | **Multi-user, isolated.** An admin creates users; each user sees only their own hosts, credentials and sessions. Roles in MVP: `admin`, `user`. | Owner, 2026-10-15 |
| D-09 | tmux is integrated through **tmux control mode**, with a fallback. | Owner, 2026-10-15 |
| D-10 | **tmux is automatic for every session**, with auto-detection. If the remote has no usable tmux, the session runs unprotected and the UI says so. It can be turned off per connection profile. Termdock never installs anything on remote hosts. | Owner, 2026-10-15 |
| D-11 | **Multi-attach: every attachment can type.** The terminal size follows the most recently active attachment; the others render that size letterboxed or scaled. | Owner, 2026-10-15 |
| D-12 | SSH authentication in MVP: **private key (with optional passphrase), password, and keyboard-interactive (OTP/2FA prompts relayed to the browser)**. Jump hosts are post-MVP. | Owner, 2026-10-15 |
| D-13 | Web login: **username + password, plus optional TOTP**. The admin can make TOTP mandatory. Includes rate limiting and lockout. | Owner, 2026-10-15 |
| D-14 | Deployment: **Docker Compose + Caddy** (automatic TLS; routes `/ws` to the daemon). | Owner, 2026-10-15 |
| D-15 | Local mode has two flavours, both in MVP. **(a)** a preset that reaches the Docker host over SSH via `host.docker.internal` (host-gateway), with a dedicated key. **(b)** a **direct mode** (`LocalTransport`, node-pty + local tmux), fully implemented even though inside the container it only reaches the container's own shell; it must be testable by running `session-manager` manually outside the container. | Owner, 2026-10-15 |
| D-16 | Workspace layout: **sidebar + tabs + split panes**, persisted server-side per user and restored in any browser. | Owner, 2026-10-15 |
| D-17 | Mobile: **responsive layout + extra-key bar** (Esc, Ctrl, Alt, Tab, arrows…). | Owner, 2026-10-15 |
| D-18 | **Everything in the repository is in English**: code, comments, docs, commit messages. The UI defaults to English and is switchable to **pt-BR**; both locales ship in MVP. The project may become open source. Conversations with the owner are in Portuguese. | Owner, 2026-10-15 |
| D-19 | **The interface is designed with the `impeccable` skill** (vendored at `.claude/skills/impeccable`, pinned in `skills-lock.json`). It owns the visual world, design system and UX passes (§11.0). | Owner, 2026-10-15 |
| D-20 | **Commit in this repository as each functional block is delivered, and push to `origin`** (`github.com/ativaone/termdock`, private; default branch `main`). | Owner, 2026-10-15 (remote added the same day) |
| D-21 | **Lean, risk-based automated testing.** Test what really needs testing. Tests are mapped into an always-run fast set and a full pre-release battery; the pre-release routine was agreed later as D-25 (§15.4). | Owner, 2026-10-15 |
| D-23 | *(Superseded by D-26 on 2026-10-16.)* Visual direction for the app (impeccable `new-work`, Operate mode): **air-traffic flight-progress strip board** — slate shell, buff session strips with a state-coloured edge, sessions grouped in state lanes; recorded as the direction contract in `apps/web/.impeccable/surfaces/app-workspace.md`. | Owner, 2026-10-15 |
| D-22 | Test container matrix reduced to alpine:3 (no tmux), ubuntu:22.04 (3.2a), ubuntu:24.04 (3.4), alpine:edge (newest packaged). Base images for deployment (node, caddy) are approved when the deploy phase starts. | Owner, 2026-10-15 |
| D-24 | **License: GNU AGPL-3.0-only** (`LICENSE`, `license` field in every manifest). "Only" keeps the choice of a later GPL version with the copyright holder; widening to "or later" stays possible. | Owner, 2026-10-16 |
| D-25 | **Pre-release routine (T2):** a `pnpm test:release` script (T0, every T1 area in sequence, Docker image builds, a scripted end-to-end smoke against the composed stack) plus a short manual checklist. No browser E2E dependency and no soak in the routine. Confirms the T1 tier. | Owner, 2026-10-16 |
| D-26 | **New visual direction, superseding D-23** (the owner rejected the strip-board look after using it). A dark violet-navy dashboard from an owner-supplied reference (described in words only; the reference image is third-party and is not committed): deep indigo base with a violet-magenta glow at the frame edge, translucent cards with fine light borders and generous radii, cyan as the primary accent, magenta for attention, sentence-case geometric type. Dark only. UI font **Plus Jakarta Sans** (`@fontsource-variable/plus-jakarta-sans` 5.3.0, approved by the owner on trial: other fonts may be tried, and the unused ones are removed once the owner signs off). Terminal panes stay near-black and effect-free. | Owner, 2026-10-16 |
| D-27 | *(Sections and profiles superseded by D-29 on 2026-10-17; the one-form setup and the return links stand.)* **First use and server setup in one form.** "Add server" has clearly separated sections (host, sign-in profile, credential). Each section lets the user pick an existing item or create a new one (generate a key, paste a key, or a password), and the form creates whatever is missing at once. The host, profile and credential pages remain for management, and every cross-link returns to where the user came from. The first-run guidance follows the same path. **As built:** the server and the credential sections offer an existing item; the sign-in section always creates a new connection profile, because picking an existing profile would leave nothing to add. The form validates all three sections before writing anything, creates a new credential first through the daemon (the step most likely to fail), then the host and profile in one SQLite transaction, and deletes that credential again if the transaction fails. | Owner, 2026-10-16 |
| D-28 | *(The toggle's place superseded by D-37 on 2026-10-19; the rest stands.)* **Workspace UX changes:** sessions take an optional name when opened and can be renamed later (all viewers see the new name, in the list and on tabs); an account menu (name + gear) holds settings and sign-out, replacing the footer sign-out icon and the language selector; the language is a rare setting, so the menu only has a "Language…" item under Settings that opens a dialog (also on the account settings page); the session list collapses to a narrow rail from a toggle at its left; the active session is marked by fill and outline, never by shifting it sideways. | Owner, 2026-10-16 |
| D-29 | **Servers replace hosts and connection profiles.** The owner found the host → profile → credential split confusing in practice. One **server** holds everything an `ssh user@host` command line would: name, address, port, the user name on the server, which credential (or none: the server prompts in the terminal) and the connection options (tmux protection, startup command, TERM, environment, keepalive, auto-reopen, scrollback). Duplicates are expected: the same machine as another user is another server, made with **Duplicate**. Credentials stay separate and reusable. A session is a terminal opened from a server; a server can have many. **Host-key decisions are kept per user and per address** (the normalized hostname as typed plus the port, like `known_hosts`): they apply to every server of that user with that address, are never shared between users, and outlive the servers, so deleting and re-adding a server never lets a revoked key back in. "Add server" has two sections (server, credential). Pre-release clean slate: one fresh initial migration, no migration from the old tables. | Owner, 2026-10-17 |
| D-30 | **Remote tmux leftovers are found and ended.** A protected session's tmux keeps running on its server while Termdock is down, by design (§5.8): the next start reattaches it. It is left behind only when Termdock forgets it: a database reset, or a session ended while it was not connected. (1) **Ending a session reaches the server:** when the session is not connected, the daemon connects just to end its tmux (the same host-key and credential rules, never prompting); if it cannot, the session ends anyway and the next connection to that server as that user ends the leftover. (2) **Leftovers are found on connect:** after a session connects, and when the server page asks, the daemon lists that user's `td-*` tmux servers on the server. Those of sessions the user already ended are ended at once; those no session record knows (another Termdock installation, or this one before a database reset) are listed on the server page with **End** and **Adopt** (a new session of that server attached to it). Sessions that run in Termdock, and other users' sessions, are never listed, ended or adopted. The installation id stays in the database: telling "this installation before a reset" from "another installation" is left to the user. (3) **End all sessions** in the workspace, a step before any database reset in the upgrade guide, and a shutdown log line saying how many sessions keep running. No time-based expiry: the owner may keep sessions for months. | Owner, 2026-10-17 |
| D-31 | **Connection retries are bounded and can be stopped.** The owner mistyped an address and got a retry every few seconds, with no way to stop it but ending the session. Supersedes the unbounded backoff of §5.7. (1) **A session that never connected** makes 4 attempts (at once, then after 5 s, 15 s and 30 s) and then waits as Disconnected with the last failure, for Retry or End. (2) **A session that lost its connection** retries after 2 s, 5 s, 10 s, 30 s and then every 60 s, for 30 minutes from the loss, then waits the same way: a protected session's tmux keeps running on its server, so Retry later reattaches it. (3) **Stop** on the retry card ends the attempts at once (the session waits as Disconnected; nothing is ended on the server). (4) **Until it first connects, a session follows its server's current address, port, user name and credential**, so fixing a mistyped server and pressing Retry works; from its first connection on, the target stays fixed as before (§9). A session waiting after these limits or a Stop is not restarted at boot; Retry starts a fresh round. | Owner, 2026-10-17 |
| D-32 | **Ended sessions can be removed.** The owner wants to clear sessions they will never reopen. **Remove from list…** in an ended session's menu (confirmed in the menu, like End) deletes it for good, with its session history (`session_events`); **Remove all ended…** at the foot of the expanded Ended group deletes every ended session of the user, after a confirmation. Only ended sessions qualify, so nothing runs on a server for them, except a leftover whose cleanup was pending (D-30): it then shows on its server's page as one this installation does not know, with End. Each removal is audited (`session.remove`). Panes that showed a removed session say so and offer to close. | Owner, 2026-10-17 |
| D-33 | **A tip when tmux runs inside a protected session.** Termdock's own tmux is invisible, so a user used to SSH clients may start their own tmux inside a session, which takes away the browser's scrollback, wheel scrolling and drag selection. When the foreground program of a tmux-protected session is `tmux`, the pane shows an info tip saying it is not needed, with **Got it** (this session, while the pane lives) and **Don't show again** (a terminal preference, `nestedTmuxTip`, which Settings → Terminal turns back on). Unprotected sessions never get it: there a tmux of the user's own is legitimate. Detection only listens and queries (`%window-renamed`, then `#{pane_current_command}`, §6.13): nothing is written into the pane, and the tab title from the program (OSC title) and the session status are untouched. A server whose startup command starts tmux on purpose shows the tip in every session until Don't show again; accepted. | Owner, 2026-10-17 |
| D-34 | **Local-CA certificates last 30 days.** A browser that accepted Caddy's security warning instead of importing its root accepts that one certificate; with Caddy's default 12-hour certificates, renewed about every 8 hours, new requests then fail while open terminals keep working (the owner's End failed this way). Importing the root does not make sense for many installs, so `TERMDOCK_TLS=internal` issues 30-day certificates (renewed about every 20 days) under a 90-day intermediate, and `deploy/.env.example` uses `internal` for the localhost trial. `auto` stays Caddy's default for public domains (ACME); for `localhost` and IPs it keeps 12-hour certificates and the docs point to `internal`. A failed action says to reload the page. | Owner, 2026-10-18 |
| D-35 | **Running behind a reverse proxy.** Developers usually keep their own reverse proxy (nginx…) on ports 80/443 and give Termdock a subdomain at the root. `TERMDOCK_TLS=off` makes Caddy serve plain HTTP on `TERMDOCK_HTTP_PORT` (no certificate, no redirect, no HTTPS listener); `TERMDOCK_BIND_ADDRESS` publishes the ports on one host address (`127.0.0.1` for a proxy on the same host); `TERMDOCK_REVERSE_PROXY` names the proxy, the only peer whose `X-Forwarded-For` Caddy believes, read right to left (`trusted_proxies_strict`), so rate limits, lockout and audit keep each user's address. Caddy stays in this mode: the single entry for `/ws` and the app, the one place that decides the client address, and the closed internal network; the proxy's configuration stays generic (install guide, "Behind a reverse proxy", with what any proxy must do and an nginx example). A sub-path is still open (§19). | Owner, 2026-10-18 |
| D-36 | **Operator password reset.** When no admin can sign in (the only admin forgot their password), `deploy/scripts/reset-password.sh <username>` runs session-manager's `reset-password` CLI in the running container. It does what an admin's reset does: a generated temporary password printed once, a forced change at the next sign-in, every sign-in of the user ended and their WebSockets closed, an `auth.password_reset` audit row (no actor, `via: operator`). Any user, not only admins: whoever runs Docker on the host already holds the database and the master key, so a narrower rule would protect nothing. `--reset-totp` also does what an admin's TOTP reset does (authenticator, backup codes and trusted devices removed, `auth.totp_reset`), for a user who lost the authenticator and the backup codes too; without it TOTP stays on. The argon2id hashing moved to `@termdock/shared` and the TOTP reset to `@termdock/db`, so web and the CLI share one implementation of each. | Owner, 2026-10-18 |
| D-37 | *(The toggle's place superseded by D-38 on 2026-10-19; the glyph stands.)* **The sidebar toggle leaves the mark's row.** The owner found the collapse toggle wrong beside the Termdock mark, whose `>_` glyph already reads like a chevron, and saw it jump below the mark in the rail. It now ends the New session row in the expanded sidebar and sits under the round New session button in the rail, so the reading order is mark, New session, toggle in both modes; the mark stands alone on its row. Its glyph says what a click does: the panel with its left column and a chevron inside the frame, pointing in to collapse and out to expand (never a bare arrow, which reads as "back"). Supersedes D-28's "toggle at its left". | Owner, 2026-10-19 |
| D-38 | **The sidebar toggle has its own row and never moves.** At the end of the New session row it still sat beside New session when expanded and under the round button in the rail, so it changed place with every click. It now has its own row under New session in both modes, and the head's rows (mark, New session, toggle) keep the same heights in both, so the toggle is drawn at exactly the same spot expanded and collapsed: the pointer stays on it and a second click undoes the first. The glyph of D-37 stays. Supersedes D-37's placement. | Owner, 2026-10-19 |
| D-39 | **A file panel per session (SFTP), superseding the §1.2 non-goal "SFTP/file transfer".** Operators need to move files to and from the servers they work on. A session's pane can open a **Files** panel beside its terminal, inside the same pane (not a split): it browses that session's server as the session's user, with upload and download of several files at once (each with a progress bar), rename, delete, new folder, a hidden-files toggle and refresh. **It runs over the session's own SSH connection** (an SFTP channel on it), so it works wherever the terminal does, including servers that ask for a password or a code at sign-in, and only while the session is connected. **One download per file** (no archive). The toggle lives on the pane it opens: in the tab row for a tab with one pane, in each pane's caption in a split, in the header on a phone (full screen). The panel opens at the terminal's folder when tmux protects the session, at home otherwise, and keeps no state across reloads. When the server offers no SFTP, the panel says what to enable there; Termdock never installs anything on it (D-10). Instance settings: **file transfer** (on by default) and **file operations in the audit log** (off by default). Out of scope for now: folder download, chmod, creating links. Specification: §5.12. | Owner, 2026-10-19 |
| D-40 | **A public project site with the documentation and an in-app help, superseding D-20's "private".** The owner made the repository public (`github.com/ativaone/termdock`) and wanted help for what the UI leaves unsaid: what happens to a session when tmux, the network or a server goes away, reconnecting, protected or not. **The site** lives in `site/` and GitHub Pages publishes it (`.github/workflows/pages.yml`, at https://ativaone.github.io/termdock): a home page that sums up the README, with the repository's screenshots, and a documentation area. Home, documentation index and **user help** are hand-written HTML in English and pt-BR, in the app's own look (`apps/web/DESIGN.md`); the **guides** (install, configuration, architecture, security, changelog) are rendered from the repository's Markdown at every build (`site/build.ts`, `marked`), English only, so the site never holds a second copy of them. **In the app:** a help button beside the account menu (workspace and management pages, desktop, rail and phone) opens the documentation area in a new tab, in the user's language; quiet "Learn more" links in the states that raise questions (reconnecting, disconnected, ended, the remote-restart notice, the nested tmux tip, host keys, missing SFTP, protection and linger on the server page) open the help at a section; the account menu ends with a discreet link to the source code on GitHub (also the AGPL source offer to network users). The help's section anchors are stable English ids shared by both languages and by the app (`apps/web/lib/links.ts`). **Kept current by tests and one rule:** `site/test` checks that both help languages carry the same anchors, every anchor the app links to, and every status, protection label, failure message and end reason the UI shows, in the catalogs' exact words; that every guide is rendered and listed; and that every internal link and anchor of the built site resolves. **Search:** every page carries its canonical URL, hreflang pairs, Open Graph and Twitter cards and schema.org data (SoftwareApplication, breadcrumbs, TechArticle), and the build writes `sitemap.xml`; the home names the searches it answers (persistent SSH in the browser, a development server or VPS, long-running jobs and coding agents, an alternative to Apache Guacamole for terminals) without comparison tables. CLAUDE.md requires user-visible changes to update the help in the same change. The help describes only what ships (no direct mode, no tmux compatibility mode). | Owner, 2026-10-19 |

### 2.2 Technical decisions (orchestrator; reversible, with rationale)

| ID | Decision | Rationale / alternatives |
|---|---|---|
| T-01 | TypeScript everywhere (strict), pinned to **6.0.3** (§12). Node.js **24 LTS** baseline (`>=24.7`), CI also on Node 26. session-manager runs its TypeScript directly with Node 24 type stripping (no build step). | Node 24 is LTS until 2028-04-30 and has `crypto.argon2` since 24.7. Node 26 becomes LTS on 2026-10-28; move the baseline once node-pty and better-sqlite3 prebuilds are confirmed for it. TS 7 rewrote the compiler and its Next.js/tooling compatibility is unverified. |
| T-02 | `@xterm/xterm` 6 in the browser; `@xterm/headless` 6 + `@xterm/addon-serialize` on the server. **The same version is pinned on both sides** (a T0 test asserts both resolve to the same version), with shared options in `packages/terminal-config`. | Same parser and engine on both ends, so a raw byte stream produces identical state. Precedent: VS Code's pty host uses headless + serialize to revive terminals. `serialize()` supports `scrollback`, `excludeModes`, `excludeAltBuffer`; what it does not restore is covered by the mode tracker (§5.3.1). |
| T-03 | `ssh2` (1.17.x) for SSH. | Mature; async `hostVerifier`, keyboard-interactive, keepalive, `setWindow`, `forwardOut`/`sock` (future jump hosts). It does not support OpenSSH certificates (roadmap). |
| T-04 | Drizzle ORM (0.45.x) + `better-sqlite3` (13.x), WAL mode. | Stable Drizzle driver. `node:sqlite` is only a release candidate, so it can replace the native dependency later. Drizzle keeps the PostgreSQL path open (D-05). |
| T-05 | **Better Auth** (1.7.x) with the `username`, `twoFactor` and `admin` plugins and the Drizzle adapter. | Maintained (Auth.js now lives under Better Auth). Built-in TOTP, rate limiting, session management and admin user creation. Alternative: hand-rolled auth (fewer dependencies, more risk). Validate fit in Phase 0 (the `username` plugin requires email+password to be enabled → users carry an email). |
| T-06 | WebSockets terminate on `session-manager`, **never on Next.js**. Caddy routes `/ws`. Browsers authenticate with a short-lived single-use ticket issued by Next.js. | Next.js has no native WS in route handlers (custom server only), and a recent advisory (CVE-2026-44578, SSRF in Next's WS upgrade path) argues against routing WS through it. Keeps the data plane independent of web deploys. |
| T-07 | tmux control mode runs over an **SSH exec channel without a PTY, using `tmux -C`** (not `-CC`), with **one tmux server per Termdock session** on a dedicated socket (`-L`) and `-f /dev/null`. | `-CC` needs a TTY and is in-band with a shell: if tmux dies, commands leak into the shell. With exec + `-C` there is no echo and no line discipline, and nothing can leak. A dedicated socket isolates the user's own tmux config and sessions. Same protocol as iTerm2's integration. |
| T-08 | Control mode requires **tmux ≥ 3.2** (3.4+ recommended). Below 3.2 → normal-mode fallback (Phase 7). tmux absent → unprotected. | 3.2 adds flow control (`pause-after`), `%extended-output`, client flags and output fairness. Distro reality: Ubuntu 22.04 = 3.2a, 24.04 = 3.4, Debian 12 = 3.3a, Debian 13 = 3.5a, Alma 9 = 3.2a, **Alma/RHEL 8 = 2.7**, AL2023 = 3.6a. |
| T-09 | The credential vault is owned by `session-manager`: AES-256-GCM with a master key (KEK) that **only** `session-manager` can read. | A leak of the SQLite file does not expose SSH secrets, and the web process cannot read them. A compromised web process can still obtain **password** credentials by re-pointing a host to an attacker-controlled sshd; keys are not disclosed (§10.1). |
| T-10 | Web UI: Next.js 16 App Router, React 19, Tailwind 4, accessible headless primitives (Radix, via shadcn/ui as a starting point), `next-intl` 4. | Conventional, lean stack; `next-intl` works without locale-prefixed routes. The **visual layer is not decided here**: the `impeccable` design pass (D-19) sets tokens, typography and component styling and may replace the shadcn defaults entirely. |
| T-11 | `zod` 4 for every boundary schema; `pino` for structured logs with redaction. | |
| T-12 | Tests: Vitest (unit/integration), Playwright (E2E), a dockerized `sshd` matrix (one image per tmux version). Lint and format: **Biome**. | Biome is a single dependency that covers both lint and format. |
| T-13 | IDs are UUIDv7 (time-ordered), generated by a small internal helper. | No dependency; sortable. |
| T-14 | No `axios` anywhere (use `fetch`). Every new dependency passes the `ats-dependency-security` inspection before install; exact versions pinned; lockfile committed. | Supply-chain policy. |
| T-15 | **Better Auth is served over HTTP from an allowlist** (`apps/web/lib/auth/http-surface.ts`): today only `GET /api/auth/get-session`, the workspace's keep-alive; every other `/api/auth/*` request answers 404 before reaching Better Auth. Sign-in, two-factor, password changes, sign-out and admin actions stay Server Actions calling `auth.api` in process. Sign-in is throttled by Termdock's own **per-IP budget** (10 attempts per minute, in `LoginLockout`), enforced in `hooks.before`, because Better Auth's limiter runs only on HTTP requests. | Found in the 2026-10-19 security review: the catch-all route exposed endpoints the app never uses (an anonymous username check, self-service profile edits, raw admin endpoints without Termdock's guards and audit rows), and the Server Action sign-in had no per-IP limit. An allowlist also keeps new endpoints of future Better Auth versions closed. |

---

## 3. Glossary (canonical terms)

These names are used in code, the database, the protocol and the UI. **Do not introduce synonyms.**

| Term | Meaning |
|---|---|
| **Server** | Everything one terminal needs, owned by one user (D-29): `kind: ssh` with hostname, port, user name and an optional credential, or `kind: local` for direct mode; plus the options (protection mode, startup command, TERM, env, keepalive, auto-reopen, scrollback lines). Duplicates are allowed. |
| **Credential** | Secret material used to authenticate: a password, or a private key with an optional passphrase. Stored encrypted; owned by one user; reusable by any of the user's servers. |
| **Address** | A server's normalized hostname (`normalizeHostname`: trimmed, lowercased, IPv6 without brackets) plus its port. Host-key decisions are kept per user and address (§5.9). |
| **Session** | A live terminal created from a server. Exists independently of any browser. Snapshots its target (host, port, username, credential) at creation (§9). Has an internal **state** and a user-facing **status**. |
| **Attachment** | One browser view attached to a session through a WebSocket channel. A session has 0..N attachments. |
| **Active attachment** | The attachment that most recently sent input or explicitly took focus; it drives the session size. |
| **Auth session** | A logged-in web session (Better Auth). Never call this just "session" in code: use `authSession`. |
| **Transport** | How bytes reach the target: `SshTransport` (ssh2) or `LocalTransport` (child_process / node-pty). |
| **Driver** | How the terminal is run over a transport: `RawPtyDriver`, `TmuxControlDriver`, or `TmuxNormalDriver`. |
| **Emulator** | The server-side headless xterm instance holding the authoritative screen state of one session. Owned by the session runtime; drivers never touch it directly. |
| **Protection mode** | The server setting `protection_mode`: `auto` (default) or `off`. |
| **Protection** | The effective result for a session: whether the remote shell survives a lost connection — `tmux-control`, `tmux-normal` or `none`. Fixed at creation (§5.7). |
| **Mode tracker** | Observe-only parser hooks on the server emulator that record terminal state the serialize addon does not restore (§5.3.1). |
| **Mode epilogue** | The escape sequences generated from the mode tracker; `Emulator.snapshot()` appends them after the SerializeAddon output in every snapshot. |
| **Snapshot** | The serialized emulator state plus the mode epilogue, sent with its `cols`/`rows` so an attachment can render the current screen. |
| **Resync** | Replacing an attachment's (or the emulator's) state wholesale with a fresh snapshot. |
| **Workspace layout** | A user's tabs and split-pane tree, each pane bound to a session id. |
| **Probe** | The capability check run against a host on connect (tmux path and version, a concrete UTF-8 locale, shell, terminfo, logind `KillUserProcesses` and linger). |
| **Installation** | One Termdock deployment, with an `installationId` generated on first boot. |

---

## 4. Architecture

### 4.1 Overview

```text
                         Internet / LAN
                               │ HTTPS (443)
                               ▼
                    ┌─────────────────────┐
                    │        Caddy        │  automatic TLS, HSTS
                    └──────┬───────┬──────┘
               /  (HTTP)   │       │  /ws (WebSocket)
                           ▼       ▼
┌──────────────────────────────┐  ┌─────────────────────────────────────────┐
│ web  (Next.js, :3000)        │  │ session-manager  (Node daemon)          │
│ CONTROL PLANE                │  │ DATA PLANE                              │
│                              │  │                                         │
│ UI (React + xterm.js)        │  │ :3001  WebSocket server (attachments)   │
│ Auth (Better Auth, TOTP)     │  │ :3002  Internal API (control plane only)│
│ Users, credentials*,         │  │                                         │
│ servers, layout, audit view  │  │ Session registry & state machines       │
│ WS ticket issuer             │  │ Emulators (@xterm/headless)             │
│                              │  │ Drivers: raw / tmux-control / tmux-norm │
│ * via :3002: the daemon      │  │ Transports: SSH (ssh2) / Local (pty)    │
│   writes rows + vault secrets│  │ Credential vault (holds the KEK)        │
└──────────────┬───────────────┘  └──────┬──────────────────────┬───────────┘
               │  internal HTTP (:3002,  │                      │
               │  bearer token)  ────────┘                      │ SSH
               │                                                ▼
               │      ┌───────────────────────────┐     ┌───────────────┐
               └─────►│ SQLite (WAL) data/app.db  │◄────│ Target hosts  │
                      │ shared volume             │     │ (tmux server  │
                      └───────────────────────────┘     │  per session) │
                                                        └───────────────┘
```

### 4.2 Responsibilities

| Concern | web (control plane) | session-manager (data plane) |
|---|---|---|
| Users, login, TOTP, admin | owns | validates WS tickets; re-checks auth-session validity and `banned` |
| Servers, layout, preferences | owns (CRUD) | reads (a session snapshots its target at creation, §9) |
| Credentials | UI; create/delete through the internal API | **writes every `credentials` row; encrypts/decrypts; sole holder of the KEK** |
| Known host keys | UI for trust decisions, through the internal API | verifies on connect; **writes every `known_host_keys` row** (pending, trust, replace, revoke) |
| Sessions | requests create/rename/terminate/retry/reopen via the internal API; reads history | **owns runtime and lifecycle; writes `sessions` and `session_events`** |
| Terminal I/O | — | WebSocket, emulators, drivers, transports |
| Instance settings | writes every key except the two on the right | writes `installation_id` and `vault_key_check` |
| Audit | writes auth/admin events; displays the log | writes host-key, credential and session-rename audit events |

The full per-table write-ownership list is in §9.

**Source of truth.** The `session-manager` process is the source of truth for whether a session is alive and in what state. The database records the *desired* state (`desired_state`), the last known status, and the history. On boot, the daemon reconciles the database against reality (§5.8).

### 4.3 Network and ports

| Listener | Exposure | Purpose |
|---|---|---|
| Caddy `:80/:443` | public | TLS termination; `/ws` and `/transfer/*` (file panel, §5.12) → `session-manager:3001`; everything else → `web:3000` |
| web `:3000` | compose network `edge` only (via Caddy) | Next.js |
| session-manager `:3001` | compose network `edge` only (via Caddy) | WebSocket attachments; file panel transfers (`/transfer/*`) |
| session-manager `:3002` | compose network **`internal` only** (web ↔ session-manager): it binds to the alias `session-manager-internal`, which exists only on `internal`, and web calls `http://session-manager-internal:3002`; Caddy is not on `internal`, so it can never route here | Internal API, bearer token |

Compose networks: `edge` connects caddy ↔ web and caddy ↔ session-manager (`:3001`); `internal` connects web ↔ session-manager (`:3002`).

Single origin: the browser talks to one origin, so cookies stay `SameSite=Strict` and there is no CORS.

**Client IP.** Caddy is the only proxy web and session-manager trust; Caddy itself believes `X-Forwarded-For` only from a reverse proxy named in `TERMDOCK_REVERSE_PROXY` (D-35), and otherwise takes the TCP peer. Better Auth's `advanced.ipAddress` reads `X-Forwarded-For` as set by Caddy (rate limits, lockout, audit); session-manager trusts `X-Forwarded-For` only on connections from Caddy's address and otherwise uses the socket address.

### 4.4 Trust boundaries

1. Browser ↔ Caddy: untrusted. TLS, auth, CSRF and Origin checks.
2. web ↔ session-manager: semi-trusted. Shared-secret bearer token on the `internal` network. session-manager re-validates `actingUserId` ownership on every user-scoped call (defense in depth; exceptions in §8.3).
3. session-manager ↔ target hosts: authenticated SSH with strict host-key verification (no TOFU without explicit user consent).
4. Database file: may leak (backups). Secrets inside it are ciphertext only.

---

## 5. Session runtime (data plane)

### 5.1 Layering

```text
          Attachments (0..N WebSocket channels)
                     ▲  snapshot + OUTPUT frames      │ INPUT, resize, activate
                     │                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ SessionRuntime  (state machine, sequencing, size policy, fan-out)    │
│   ├── Emulator  (owned by the runtime; headless + serialize + modes) │
│   └── Driver    (RawPtyDriver | TmuxControlDriver | TmuxNormalDriver)│
│          └── Transport (SshTransport | LocalTransport)               │
└──────────────────────────────────────────────────────────────────────┘
```

Canonical interfaces. They live in `apps/session-manager/src/core/types.ts` (the source of truth; the block below mirrors it, with `TransportError` omitted) and are **frozen in Phase 0** with the other canonical contracts (§16.1). Implementation details are refined in Phase 1.

```ts
interface Dimensions { cols: number; rows: number }

interface ExecResult { code: number | null; signal: string | null }
interface ExecChannel {
  readonly stdout: AsyncIterable<Uint8Array>; readonly stderr: AsyncIterable<Uint8Array>;
  write(data: Uint8Array): void; end(): void;
  pause(): void; resume(): void;                        // stdout backpressure (§5.5)
  readonly exit: Promise<ExecResult>;
}
interface PtyChannel extends ExecChannel { resize(dims: Dimensions): void }
interface PtyOptions extends Dimensions { term: string; env?: Record<string, string> }

/** Byte pipe to a target. Knows nothing about terminals. */
interface Transport {
  connect(signal: AbortSignal): Promise<void>;          // TCP + SSH handshake + host verification + auth (no-op for local)
  exec(command: string): Promise<ExecChannel>;          // no PTY — probes and `tmux -C`
  openPty(opts: PtyOptions): Promise<PtyChannel>;       // raw mode / tmux-normal
  close(): Promise<void>;
  onLost(cb: (err: TransportError) => void): void;      // connection dropped after connect() succeeded
}

/** Authoritative terminal state of one session. Owned by the runtime; drivers never write to it directly. */
interface Emulator {
  readonly cols: number; readonly rows: number;
  write(data: Uint8Array): void;
  resize(dims: Dimensions): void;                       // applied through the write queue (§5.5)
  flush(): Promise<void>;                               // resolves once every earlier write is parsed (snapshot barrier)
  snapshot(): Promise<Uint8Array>;                      // takes its own barrier (§5.4): SerializeAddon output + mode epilogue + parser tail
  onReply(cb: (data: Uint8Array) => void): void;        // query replies; forwarded only for none / tmux-normal (§5.3)
  onTitle(cb: (title: string) => void): void;
  onBell(cb: () => void): void;
  dispose(): void;
}

interface DriverContext {
  transport: Transport;
  output(chunk: Uint8Array): void;                  // runtime assigns seq, writes emulator, fans out
  resized(dims: Dimensions): void;                  // driver reports the effective size (tmux-control)
  replaceState(build: (fresh: Emulator) => void | Promise<void>): Promise<void>; // tmux rebuild: runtime creates a fresh emulator, driver fills it, runtime swaps + resyncs
  banner(text: string): void;
  onShellExit(info: { code: number | null }): void;
  onDesync(reason: string): void;
}

/** Runs a terminal over a transport. */
interface Driver {
  readonly protection: 'tmux-control' | 'tmux-normal' | 'none';
  start(ctx: DriverContext, dims: Dimensions): Promise<void>;  // attach-or-create; resolves once the state is in sync
  input(data: Uint8Array): void;                // user keystrokes / paste (+ emulator query replies for none / tmux-normal)
  resize(dims: Dimensions): void;
  detach(): Promise<void>;                      // leave the remote alive (graceful shutdown)
  terminate(): Promise<void>;                   // kill the remote shell / tmux server
}

/** Decrypted credential material, held only in memory for the duration of a connect. */
type CredentialSecret =
  | { kind: 'password'; password: string }
  | { kind: 'private_key'; privateKey: string; passphrase?: string };

/** Source of credential secrets: the vault in production, a dev file provider in P1 tests. */
interface CredentialProvider {
  get(credentialId: string, userId: string): Promise<CredentialSecret>;
}

interface AttachmentHandle {
  readonly id: string;                          // internal only; never sent to clients
  send(frame: Uint8Array): void;                // encoded frames/messages for this attachment's channel
  readonly bufferedAmount: number;
}

/** Boundary of one session's runtime. In-process in the MVP; §18.1 moves it behind a socket. */
interface SessionHost {
  readonly sessionId: string;
  start(): Promise<void>;
  attach(attachment: AttachmentHandle, viewport: Dimensions): void;
  detach(attachmentId: string): void;
  input(attachmentId: string, data: Uint8Array): void;
  activate(attachmentId: string): void;
  viewport(attachmentId: string, dims: Dimensions): void;
  resync(attachmentId: string): void;
  retry(): Promise<void>;
  terminate(): Promise<void>;
  shutdown(): Promise<void>;                    // graceful shutdown: leave protected remotes alive
}
```

- **The runtime owns the emulator.** Drivers deliver output with `ctx.output()`, report the effective size with `ctx.resized()` (tmux-control, §6.6), and rebuild state with `ctx.replaceState()` (tmux-control, §6.8). Only the runtime calls `Emulator.write/resize/snapshot`.
- **Query replies:** emulator `onReply` → runtime → `driver.input()`, only for protection `none` / `tmux-normal` (§5.3).
- **`SessionHost`** is the per-session runtime boundary prepared for §18.1: the registry and the WS layer talk to a session only through it. The MVP has one in-process implementation (`SessionRuntime`).
- **`CredentialProvider`** decouples `SshTransport` from the vault, so the transport and runtime can be built and tested before the vault exists.

### 5.2 Drivers

| Driver | When | Mechanics |
|---|---|---|
| `RawPtyDriver` | protection `none` | `transport.openPty()` (ssh2 `shell()` with `term`/`cols`/`rows`, or node-pty locally). Output bytes → `ctx.output()`. Input bytes → channel. Resize → `setWindow` / `pty.resize` (the runtime resizes the emulator, §5.5). |
| `TmuxControlDriver` | protection `tmux-control` (tmux ≥ 3.2 + UTF-8 locale) | `transport.exec("exec sh -c '… <tmux_path> -u -L … -C …'")` (§6.3). Parses the control protocol; `%output` for the session's pane → unescape → `ctx.output()`. Input via `send-keys -H`. Resize via `refresh-client -C`; the confirmed pane size goes to `ctx.resized()`. On (re)attach, rebuilds state from `capture-pane` through `ctx.replaceState()` (§6.8). |
| `TmuxNormalDriver` | protection `tmux-normal` (tmux < 3.2 present) — **Phase 7** | `openPty()` running `<tmux_path> -u -L … -f <generated conf> new-session -A …` with an "invisible" configuration (§6.11). Output is tmux's re-render; best-effort scrollback restore. |

### 5.3 Emulator and query authority

- One `@xterm/headless` `Terminal` per session, built from `packages/terminal-config` (same options and Unicode provider as the browser). Scrollback is the session's `scrollback_lines`, taken from the profile (default **5,000 lines**; snapshot cost §5.4, memory budget §17). It is authoritative everywhere: the server emulator, tmux `history-limit` (§6.3) and the browser, which receives it in `session.attached` (§7.3).
- **Query-answer authority.** Terminal queries (DA1/DA2, DSR/CPR, DECRQM, XTVERSION, window-ops reports, OSC 4/10/11/12 color queries) must be answered **exactly once**:
  - `none` / `tmux-normal`: the **server emulator** answers: emulator `onReply` → runtime → `driver.input()`. Without this, a program waiting for a CPR would hang while no browser is attached.
  - `tmux-control`: **tmux** answers (its internal emulator replies to the application). The server emulator must **not** answer.
  - The browser **never** answers.
- Implementation: `installQuerySilencer(term)` in `packages/terminal-config` registers parser handlers (`registerCsiHandler` / `registerOscHandler` / `registerDcsHandler`) that consume the query forms and return `true`, so the default reply is never generated. It is applied in the browser always, and on the server in `tmux-control`. A T0 coverage test feeds every query form: with the silencer there is no reply; without it there is exactly one. **[SPIKE S1]** Establish the full list of query forms in xterm 6.
- User-originated events (keys, mouse reports, focus in/out when the app enabled `?1004`, bracketed paste) are never filtered.

### 5.3.1 Reattach fidelity and the mode tracker

The serialize addon restores the buffer (scrollback and screen), the cursor position, the alternate buffer, the DECSTBM scroll region, the SGR pen and a set of DEC modes. It does **not** restore: mouse encoding (`?1005` / `?1006` / `?1015`), cursor style (DECSCUSR), tab stops, character sets, the DECSC saved cursor, the window title, or kitty keyboard / modifyOtherKeys state.

- **Mode tracker** (`packages/terminal-config`): observe-only parser hooks (every handler returns `false`, so xterm's own handling still runs) that record DECSET/DECRST including 1005/1006/1015, DECSCUSR, HTS/TBC (tab stops) and the last title. It is installed on every server emulator, so modes re-applied during a tmux rebuild (§6.8) are recorded as well.
- **Mode epilogue**: `Emulator.snapshot()` returns the SerializeAddon `serialize()` output followed by the escape sequences that restore the tracked state, so every snapshot carries it.
- **Still not restored** (documented limitation): character sets (G0/G1), the DECSC saved cursor, and kitty keyboard / modifyOtherKeys state.
- Plain browser reattach is therefore **exact for buffer, cursor and the tracked modes**. S1 enumerates the remaining gaps against xterm 6; P1 B asserts a mode/state probe (mouse encoding, cursor style, alt screen) in addition to SerializeAddon `serialize()` equality between client and server.

### 5.4 Output pipeline, sequencing and the snapshot barrier

1. The driver delivers output chunks (`Uint8Array`) through `ctx.output()`.
2. `SessionRuntime` assigns each chunk a monotonically increasing `seq` (u64) and:
   a. writes it to the emulator (`term.write(bytes)`, which is UTF-8-stateful);
   b. appends it to each live attachment's outbound coalescing buffer.
   `seq` is per session and monotonic for the lifetime of the daemon process: it survives `reopen` and tmux rebuilds. Any runtime replacement (reopen, tmux rebuild) sends a `SNAPSHOT` to every attachment first.
3. Coalescing: flush every **8 ms** or at **64 KiB**, whichever comes first, as one `OUTPUT` frame carrying the seq of its last chunk.
4. **Snapshot barrier** (on attach, resync, lag recovery or a tmux rebuild): `Emulator.snapshot()` enqueues its own barrier and serializes synchronously inside xterm's write callback, so the payload reflects exactly the bytes and resizes submitted before the call; the runtime records `snapshotSeq` = the last seq written before calling it. Never emulate it with `await flush()` + a synchronous serialize: the promise continuation runs after xterm has parsed later chunks (ADR-0001). The payload is SerializeAddon `serialize()` + the mode epilogue (§5.3.1) + the parser tail (an escape sequence or UTF-8 character still incomplete at the barrier). Send `SNAPSHOT(snapshotSeq, cols, rows)` (§7.2) and then only chunks with `seq > snapshotSeq`.
5. **Snapshot cost and cache** (measured in ADR-0001): ~85 ms of serialize CPU at 5k scrollback lines, ~550 ms at 10k (superlinear), during which the daemon's event loop is blocked. Hence: one snapshot per (session, seq), shared by every attachment that needs it; resizes do **not** take snapshots (§5.5); default scrollback 5,000 lines. Moving serialization to a worker thread is a recorded optimization (§17).
6. The client applies a snapshot as: `term.reset()` → `term.resize(cols, rows)` from the frame header → `term.write(snapshot)`. Browser conditions from ADR-0001: one `Utf8Aligner` per terminal for the snapshot and every `OUTPUT` payload (xterm 6 drops a character when a chunk ends inside certain UTF-8 sequences), the same pinned xterm version and options with Unicode 11 active, and the query silencer installed after every addon. While a `SNAPSHOT` for a channel is being decompressed and applied, the client queues that channel's `OUTPUT` frames; afterwards it drops those with `seq <= snapshotSeq` and applies the rest in order. A client can ask for a fresh snapshot at any time with `terminal.resync { channel }` (e.g. after a decode error).
7. The client and server parse identical bytes at identical sizes with the identical engine version, so they remain identical. A resync is used whenever there is doubt: lag, tmux `%pause`, driver desync, a client error.

### 5.5 Attachments, size policy, backpressure

**Size policy (D-11)**

- Each attachment reports its *fitted viewport* (`cols × rows` computed by the fit addon) on attach and on change.
- An attachment becomes **active** when it sends `INPUT` or `terminal.activate` (focus or click on the pane).
- When the active attachment's viewport differs from the session size, the session resizes to it (debounced 100 ms).
- **Resize rule (sequenced).** A resize is an event in the output stream. The server flushes the coalescing buffer (so the last `OUTPUT` frame ends at seq N), applies the resize to its emulator through the write queue (`Emulator.resize`, which lands after the bytes up to N), and sends `terminal.resized { channel, cols, rows, seq: N, activeAttachment }` to every attachment. The client applies its own `term.resize(cols, rows)` after writing every `OUTPUT` with `seq <= N` and before any later one. Same bytes, same engine, same resize position → identical reflow, with no snapshot (snapshots cost hundreds of ms, §5.4). Clients never resize their buffer on their own initiative; `activeAttachment` tells the receiving attachment whether it is the active one (letterbox/scale in the UI). Clients never see attachment ids.
- The order is driver-specific:
  - raw / tmux-normal: emulator resize (queued) + `setWindow` / `pty.resize` → `terminal.resized`.
  - tmux-control: `refresh-client -C` → `%layout-change` → the driver calls `ctx.resized()` → the runtime resizes the emulator (queued) → `terminal.resized` (§6.6).
- Passive attachments render the session size, scaled down to fit, or letterboxed when larger. They never resize the session until they become active.
- The session size is clamped to 20×5 … 500×200.

**Backpressure**

| Path | Rule |
|---|---|
| Attachment socket | If `ws.bufferedAmount` > 2 MiB → mark the attachment **lagging** and stop sending `OUTPUT`. When it drops below 256 KiB → send a fresh `SNAPSHOT` (resync) and resume. Memory per slow client stays bounded. |
| Emulator ingest (`none` / `tmux-normal`) | If pending emulator writes exceed 8 MiB → `pause()` the transport stream; resume below 1 MiB. |
| Emulator ingest (`tmux-control`) | The same 8 MiB / 1 MiB `pause()` / `resume()` on the exec channel. While it is paused the SSH window fills, tmux's output age grows, and `pause-after` flow control engages (§6.7). |

### 5.6 State machine

Internal states (persisted as `sessions.state`; transitions emitted as `session_events`):

```text
new ─► connecting ─► verifying_host ─┬─► authenticating ─┬─► probing ─► starting ─► syncing ─► ready
                                     │                   │                                     │
                     awaiting_host_key                awaiting_user_input                      │
                     (user decision)                  (keyboard-interactive)                   │
                                                                                               │
awaiting_host_key ── accept ──► connecting (reconnect; the key is now trusted)                 │
ready ── transport lost ──► reconnecting (backoff) ──► connecting … ──► syncing ──► ready      │
ready ── shell exited (confirmed, §6.10) ──► ended                                             │
any   ── terminate requested ──► terminating ──► ended                                         │
any   ── non-retryable error (auth rejected, host key mismatch or rejected) ──► failed         │
failed ── user Retry ──► connecting                                                            │
```

- `awaiting_host_key`: the unknown key is stored as `pending` and the connection is aborted; an accept trusts that key and reconnects (§5.9).
- `awaiting_user_input`: on prompt expiry the connection is closed and the session stays here; the next connect attempt re-prompts (§5.10).

User-facing status (what the UI shows — never the internal detail). The mapping is `toSessionStatus(state, wasReady)` in `packages/protocol`, where `wasReady` means the session reached `ready` at least once (`last_ready_at` is set):

| User-facing status | Internal states |
|---|---|
| **Connecting…** | `new`, `connecting`, `verifying_host`, `authenticating`, `probing`, `starting`, `syncing` — when `wasReady` is false (first start) |
| **Restoring…** | the same states when `wasReady` is true (reattach after a drop, a restart or a retry) |
| **Connected** (+ shield icon when protected) | `ready` |
| **Action required** | `awaiting_host_key`, `awaiting_user_input` |
| **Reconnecting…** (with countdown) | `reconnecting` |
| **Disconnected** (with Retry button) | `failed` |
| **Ended** | `terminating`, `ended` |

### 5.7 Reconnect and restore policy

Retries come in bounded rounds (D-31, `core/backoff.ts`), with ±20% jitter on every wait. A session that never connected makes 4 attempts: at once, then after 5 s, 15 s and 30 s. A session that was connected (a lost connection, or a daemon restart) retries after 2 s, 5 s, 10 s, 30 s and then every 60 s, as long as the attempt starts within 30 minutes of the loss. When a round runs out, the session goes `failed` with the code of its last failed attempt (HOST_UNREACHABLE, CONNECTION_LOST, CHANNEL_FAILED, AUTH_TIMEOUT …); **Stop** (`POST /sessions/:id/stop`, §8.3) ends a round at once with `RETRIES_STOPPED`, closing an attempt in flight and leaving any remote tmux running. Every status of a round carries its progress (`attempt`/`maxAttempts` or `retryUntil`, §7.3). An unknown host key pauses the loop in `awaiting_host_key` until the user decides; keyboard-interactive auth pauses it in `awaiting_user_input` until the user answers. Auth rejection or a host-key mismatch → `failed` (no automatic retry). Until its first `ready`, an SSH session follows its server's current address, port, user name and credential at every attempt (event `target_followed`); from then on its target is fixed (§9).

**`desired_state` transitions**

- User terminate → `desired_state = terminated` (then `terminating` → `ended`).
- A session that reaches `ended` (any reason) → `desired_state = terminated`. A `reopen` sets it back to `running`.
- A `failed` session (a non-retryable cause, a round that ran out, or Stop) keeps `desired_state = running`, but boot restore skips it until the user retries (§5.8); Retry starts a fresh round.
- **Retry** (`POST /internal/v1/sessions/:id/retry`, §8.3) restarts the connect loop with the same `tmux_token`, so a protected session reattaches the same tmux session. "Retry now" during `reconnecting` also skips the remaining backoff wait.
- **Reopen** is allowed only for `ended` sessions or sessions with protection `none` (new shell, same session id, new runtime; §5.4 for seq continuity).

| Event | `tmux-control` | `tmux-normal` (P7) | `none` |
|---|---|---|---|
| Browser closed / reopened | Snapshot from the emulator. Instant. | same | same |
| Network drop / SSH connection lost | Reconnect → attach the same tmux session → capture → rebuild the emulator → resync. The user sees "Reconnecting…" then the same screen. | Reconnect → attach; history restored best-effort via `capture-pane` | Shell is lost. If `auto_reopen` (default **on**): open a new shell in the same emulator, after writing a dim banner line (`── connection lost at 14:32 · new shell started (session not protected) ──`); prior scrollback kept. Else → `ended` (reason `connection_lost`). |
| session-manager restart | Boot restore: reconnect → capture → rebuild (§5.8) | same, best-effort | Screen state was in RAM and is lost. If `auto_reopen`: new shell + banner `Termdock restarted`. Else `ended` (reason `service_restarted`). |
| Remote host rebooted | tmux server is gone. Detected by session identity mismatch (§6.10) → new tmux session + banner `remote host restarted · previous shell lost` | same | same as a network drop |
| User types `exit` / the shell dies | `%exit`, confirmed with `has-session` (§6.10) → `ended` (reason `shell_exited`); the per-session tmux server exits with its last session. A channel EOF without `%exit` follows the transport-loss path. | same | `ended` |

A session's effective protection is fixed at creation. If a later reconnect finds tmux missing or too old, the session degrades to `none` with a banner and an event. It never changes silently.

### 5.8 Boot restore and graceful shutdown

**Boot**

1. Take the **data directory lock**, `<data dir>/session-manager.lock` (`store/data-dir-lock.ts` over `tryFileLock` in `packages/db`). The lock file is a tiny SQLite database that holds no data: a connection in `locking_mode = EXCLUSIVE` runs one write transaction and keeps its exclusive lock until it closes. These are POSIX record locks, so the kernel drops them when the process exits, however it exits (no stale lock, no pid check), and they hold across containers that mount the same volume. A second session-manager, or `vault rotate` (§10.2), on the same data directory refuses to start while the lock is held. web does not take it: it never writes credential ciphertexts or the vault key check.
2. Open the DB (`busy_timeout` 250 ms, §9) and apply the migrations; ensure an `installationId` exists.
3. Load the vault KEK; fail fast if it is missing or wrong (checked against a stored key-check value, at its key version).
4. End every session still `terminating`: the previous daemon stopped in the middle of its terminate (below). It becomes `ended` (`user_terminated`, with its `state_changed` event) and is never restored; a tmux it left on its server is ended by the next connection to that server as that user (§6.12).
5. For every session with `desired_state = running`, except those whose last state is a non-retryable `failed` (they wait for the user's Retry), create a runtime and start it with concurrency 4 and per-host spacing (avoids SSH connection storms).
6. Mark the start in `session_events` (`restore_started` / `restored` / `restore_failed`). One info log line says how many sessions boot restore started (reattached, for tmux-protected ones) and how many interrupted terminations step 4 ended.
7. Start the event retention job (§10.2): the first purge runs a few minutes after boot, then every 6 hours.

**SIGTERM (graceful; the daemon's internal shutdown budget is 25 s, inside compose's `stop_grace_period: 30s`)**

1. Stop the retention job: no purge chunk starts after this.
2. Stop accepting attachments.
3. Notify clients (`server.shutting_down`) so they display "Restoring…" instead of an error.
4. For `tmux-control` sessions, detach the control client cleanly (send an empty line, wait for `%exit`) so the remote tmux keeps running. A terminate still running its one-shot remote cleanup (below) is aborted at once: the session ends with its cleanup pending, before the final flush.
5. Persist states and flush the batched writer (§9); close transports. One info log line says how many tmux-protected sessions keep running on their servers (desired running, not parked as failed): the next start reattaches them (D-30).
6. Close the DB and release the data directory lock.

**Terminate while not connected (D-30)**

- A live driver kills its own tmux server (§6.10). Without one (the session is reconnecting, waits for a host-key decision or a prompt, failed, or was loaded from history), a `tmux-control` session's tmux still runs on the server, so the runtime opens a one-shot connection just to end it. It goes through the session's transport factory (the owner's host-key decisions for the session's address, the stored credential) with hooks of its own: no state change, an unknown host key fails it (nothing is recorded as pending: only a session's own connect does that), a mismatched or revoked key fails closed (audited as at any connect), and a keyboard-interactive round is answered with nothing at once, so it never prompts. The connect is bounded at 10 s (the handshake timeout for a credential that may prompt is 110 s); the tmux path comes from the stored probe (`probe_json`, a probe runs only when none is stored, 8 s); `killServerCommand` (§6.3) runs on the session's socket (5 s); the connection closes. The whole cleanup is bounded at 25 s, and at most 4 run at once in the process (no SSH storms). Protection `none` leaves nothing behind and `null` never launched tmux: no cleanup.
- The session stays `terminating` meanwhile: `desired_state = terminated` is written first, so boot never restores it, and the runtime is not idle, so it is not evicted. Success → session event `remote_cleanup`. Any failure (connect, sign-in, host key, a bound, the kill, a deleted server) → the session ends anyway, with event `remote_cleanup_failed { code }`, and the `session.status` of its `ended` transition carries `remoteCleanup: 'pending'` (its `detail` stays the end reason). The next connection to that server as that user ends the leftover (§6.12).
- `POST /sessions/:id/terminate` answers within 3 s (web's internal API calls time out after 5 s); a cleanup still running then ends the session later, through `session.status`. A second terminate shares the first; Retry does nothing to a session that is ending; Reopen waits up to 3 s for a running cleanup and answers `409` while the session is not ended yet.

### 5.9 Host key verification

- Table `known_host_keys`: rows per **user and address** (normalized hostname + port, D-29) and key type, with `public_key_b64` and `status ∈ {trusted, pending, revoked}` (at most one `trusted` row per user, address and key type). A decision therefore applies to every server of that user with that address, is never shared between users, and has no foreign key to `servers`: deleting a server keeps its address's decisions, so a revoked key cannot come back through a re-added server. Rows go only with the user (cascade); `pending` rows expire as below. session-manager writes every row (§9).
- **Fingerprint format.** Fingerprints are compared in OpenSSH format `SHA256:<unpadded base64>` (43 base64 characters). Pasted pre-trust fingerprints are normalized to that form (trimmed, `SHA256:` prefix added if missing, `=` padding removed) before storage or comparison.
- The ssh2 `hostVerifier(key, callback)` async form computes the fingerprint and the key type (parsed from the key blob).
  - **Trusted match** → continue.
  - **Revoked key** (its fingerprint matches a `revoked` row of the address) → handled like a mismatch, also when nothing is trusted any more: `failed` with `HOST_KEY_MISMATCH`, `hostkey.prompt { …, mismatch: true, revoked: true }`, audit `host_key.revoked_presented`. It is never recorded as pending; `hostkey.decision` and `trust-key` refuse it, and only replace-key trusts it again.
  - **No trusted key for this address (unknown key)** → store the key as `status 'pending'` (with `public_key_b64`), **abort the connection**, and move the session to `awaiting_host_key`; broadcast `hostkey.prompt { sessionId, keyType, fingerprint, mismatch: false }`. The client answers `hostkey.decision { sessionId, fingerprint, accept }`. Accept → the daemon trusts exactly that pending key, matched by fingerprint (audit event), and reconnects. Reject → `failed`.
  - **On the reconnect**, a different key produces a new prompt if the address still has no trusted key, or a mismatch if a trusted key exists.
  - **Mismatch with a trusted key** → `failed` with code `HOST_KEY_MISMATCH`, a red alert, and an audit event. There is **no in-flow accept**. The owner must go to a server page with that address and "Replace trusted key", typing the hostname to confirm (`POST /internal/v1/servers/:id/replace-key`); "Revoke" marks a trusted key `revoked` (`…/revoke-key`). The page says the decision applies to all of the user's servers at that address.
  - **Pending rows expire after 24 h.** A decision that arrives after its pending row expired trusts nothing; the next connect attempt prompts again.
- Pre-trust options on the server page: paste an expected fingerprint (normalized, then recorded as trusted via `trust-key`), or "Test connection" (internal API `servers/:id/test`), which records the presented key as `pending` and shows its fingerprint before any session exists; the user then trusts it via `trust-key`.
- Never `StrictHostKeyChecking=no`, in any code path, including tests (tests use pre-seeded keys).

### 5.10 Keyboard-interactive relay

- ssh2 runs with `tryKeyboard: true`. For connections that may prompt, ssh2's `readyTimeout` is set explicitly to **110 s**, so the handshake outlives the prompt timeout. On `keyboard-interactive` with prompts:
  - Exactly one prompt matching `/password/i`, with a stored password credential, on the first round → answer automatically (at most once per connection attempt, to avoid loops).
  - Otherwise → state `awaiting_user_input`; broadcast `auth.prompt { sessionId, promptId, name, instructions, prompts: [{ text, echo }] }` to all of that user's connections. The first `auth.response { sessionId, promptId, answers }` carrying the current `promptId` wins; answers with any other `promptId` are stale and discarded.
  - **Prompt timeout 100 s**, below OpenSSH's default `LoginGraceTime` of 120 s. On expiry the daemon closes the connection and the session stays in `awaiting_user_input` (not `failed`); the next connect attempt prompts again with a new `promptId`. That attempt starts only when someone can answer: an attachment opens the session, or the user presses Retry. There are no unattended prompt loops (repeated failed logins can trip fail2ban-style defenses on the host).
- Answers are never logged, persisted or echoed back. `echo: false` prompts are rendered as password inputs.
- Host text is capped and cleaned by the daemon, and the panel quotes it under Termdock's own framing (§10.2).

### 5.11 Capability probe

**Remote command rule.** Every command Termdock runs on a remote (probe, tmux launch, `has-session`, socket recovery, normal-mode conf write) is wrapped as `exec sh -c '<POSIX script>'`, because the login shell that sshd uses to run it may be fish or csh. The script is sent as a **single line** (statements joined with `;`), since csh/tcsh rejects a raw newline inside single quotes; the multi-line layouts in this document are for readability only. Quoting goes through one shell-escaping helper (**[SPIKE S2]**).

On every successful SSH connect, before starting a driver, run one exec:

```sh
exec sh -c '
  printf "shell=%s\n" "$SHELL"
  if p=$(command -v tmux 2>/dev/null); then printf "tmux_path=%s\ntmux=%s\n" "$p" "$("$p" -V)"; fi
  l=$(locale -a 2>/dev/null | grep -iE "^c\.utf-?8$" | head -n 1)
  [ -n "$l" ] || l=$(locale -a 2>/dev/null | grep -iE "utf-?8" | head -n 1)
  [ -n "$l" ] && printf "utf8_locale=%s\n" "$l"
  infocmp tmux-256color >/dev/null 2>&1 && echo ti_tmux256=1
  command -v systemd-run >/dev/null 2>&1 && echo systemd_run=1
  printf "linger=%s\n" "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"
  printf "kill_user_processes=%s\n" "$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses 2>/dev/null)"
'
```

The probe prints `tmux_path=<absolute path>` and a concrete `utf8_locale=<name>`; the launch uses that absolute tmux path and exports `LC_CTYPE=<utf8_locale>` (§6.3). The probe's key/value output is stored on the session (`probe_json`). Mode selection:

| Server `protection_mode` | Probe result | Effective protection |
|---|---|---|
| `auto` (default) | tmux ≥ 3.2 and a UTF-8 locale | `tmux-control` |
| `auto` | tmux present but < 3.2 (or control mode unusable) | `tmux-normal` (until P7 ships: `none` + "tmux too old" notice) |
| `auto` | no tmux | `none` + "not protected" notice |
| `off` | any | `none` |

Version strings like `next-3.9`, `openbsd-7.6` and `3.4a` must parse (iTerm2 lesson).

**logind rules** (`KillUserProcesses=yes` makes logind kill tmux when our SSH login session ends). `KillUserProcesses` is read with `busctl` (output `b true` / `b false`), linger with `loginctl`:

| `KillUserProcesses` | Linger | Launch |
|---|---|---|
| `no`, unknown, or no systemd | any | plain launch |
| `yes` | `yes`, and `systemd-run` present | `systemd-run --user --scope --quiet <tmux …>`, so the tmux server escapes the login-session scope |
| `yes` | `yes`, but `systemd-run` absent | **No reliable protection** (linger does not protect processes inside the login-session scope): same warning as the next row. |
| `yes` | `no` | **No reliable protection.** The session still runs `tmux-control`, but the UI and host diagnostics show the warning "remote may kill tmux on disconnect — enable linger". Protection is never claimed silently. |

### 5.12 File panel (D-39)

A session's pane can show the files of its server beside the terminal. Everything runs as the session's user, over an **SFTP channel on the session's own SSH connection**: no second sign-in (servers that prompt for a password or a code work as the terminal does), nothing installed on the server, and no file panel while the session is not connected. Local sessions (D-15) have none until their transport gets a file-system adapter. Schemas: `packages/protocol/src/files.ts`.

**Channel.** The runtime opens the SFTP channel on first use (`FileHost.sftp()`, implemented by `SessionRuntime`) and reuses it while the connection lives; a lost connection, a reconnect or the end of the session drops it, and the file service closes it after 5 minutes without requests or transfers. A server that refuses the `sftp` subsystem (or whose sftp-server exits at once) answers `SFTP_UNAVAILABLE`; the panel then explains what to enable on the server (`Subsystem sftp internal-sftp` in `sshd_config`, then reload sshd). A session that is not `ready` answers `SESSION_NOT_CONNECTED`.

**Requests (WebSocket).** Metadata travels over the tab's WebSocket as `files.request { requestId, sessionId, request }`, answered by exactly one `files.result { requestId, result | error }` (§7.3). The daemon checks ownership like an attach, never awaits a file request inside the connection's message queue (a slow listing must not delay keystrokes), and allows 8 in flight per connection (`RATE_LIMITED` beyond). Operations:

| `op` | Does | Result |
|---|---|---|
| `open` | — | `home` (SFTP `realpath .`), `cwd`: the terminal's folder (`#{pane_current_path}` in `tmux-control`, §6.13), null in `none` |
| `list` | `realpath` then `readdir`; links get a `stat` for their target and a `readlink` | canonical `path`, `entries` (lstat view), `truncated` beyond 10 000 entries |
| `mkdir` | refuses an existing name (`CONFLICT`) | the new entry |
| `rename` | refuses an existing target (`CONFLICT`); never replaces | the entry at its new path |
| `remove` | depth first, `lstat` only: a link is removed as a link, never followed; `files.progress { removed }` while it runs; `files.cancel` stops it (`CANCELLED`) | `removed` (nested entries included) |
| `upload` | checks the name; without `overwrite`, an existing name is `CONFLICT`; mints a URL | `transferId`, `url` |
| `download` | the path must be a file (links followed); mints a URL | `transferId`, `url`, `name`, `size` |

Names follow `fileNameProblem` (non-empty, not `.`/`..`, no `/` or NUL, at most 255 UTF-8 bytes; `NAME_INVALID`). SFTP statuses map to `NOT_FOUND` (no such file), `PERMISSION_DENIED`, and `FILE_OP_FAILED` (generic failure, with the server's message cleaned and capped); a connection that drops mid-request is `SESSION_NOT_CONNECTED`.

**Transfers (HTTP).** Bytes never go over the WebSocket: its queue would hold keystrokes behind a file, and frames are capped at 1 MiB. Caddy forwards `/transfer/*` to session-manager's `:3001` listener, beside `/ws` (§4.3). An `upload` or `download` request mints a **single-use URL** valid 60 s (`/transfer/upload/<token>`, `/transfer/download/<token>`; 32 random bytes), bound to the user, the auth session, the session, the direction and the path; the daemon re-validates the auth session when the URL is used, and revoking it (sign-out, password change, ban) cancels the user's transfers and voids unused URLs.

- **Upload:** `POST` with the raw bytes (one file per request). `Origin` must be the public origin (a development setup whose WebSocket URL points at another port gets a CORS preflight answer for that origin only). The daemon writes a temporary file in the target folder (`.<name>.td-<random>.part`, created exclusively), then renames it into place: a failed or cancelled upload leaves no partial file. **Replace** keeps the old file's permission bits and is atomic where the server offers `posix-rename@openssh.com` (OpenSSH); elsewhere the old file is removed first. The answer is `{ entry }` or `{ code, message }`.
- **Download:** a plain `GET` the browser's own download manager handles (any size, phones included). The single-use URL is the whole authorization (`Sec-Fetch-Site` is not checked: a development setup serves the app and the daemon from two sites). Headers: `Content-Type: application/octet-stream`, `Content-Disposition: attachment` with an RFC 6266/5987 file name, `Content-Length` from the size at open time (exactly that many bytes are sent, so a growing log still ends cleanly), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: no-store`. A downloaded HTML file can never run as a Termdock page.
- **Progress:** `transfer.progress { transferId, bytes, size, state }` to the connection that minted the URL: at the start, at most four per second, and at the end. It counts bytes written to the server (upload) or sent towards the browser (download), so a buffering proxy cannot make a bar run ahead. A URL that expires unused ends with `failed` and `TRANSFER_EXPIRED` (the browser never started that download, for example while it asks whether to allow several). `transfer.cancel` stops a transfer or voids an unused URL.
- **Throughput.** ssh2's SFTP streams keep one request in flight (about 650 KiB/s at 50 ms of latency), so the daemon pipelines its own reads and writes: 32 KiB requests, at most 16 in flight per transfer. The window is bounded on purpose: a transfer shares the TCP connection with the session's keystrokes.
- **Limits:** 6 transfers per user at once (`RATE_LIMITED`); an upload that sends nothing for 60 s is cancelled; the listener's Node request timeout is off for these routes (an upload may take hours). Streams only: nothing is spooled to the daemon's disk or held in memory beyond the window.

**Settings and audit.** Two web-owned instance settings, read by the daemon: `file_transfer_enabled` (default true; false: every request is `FILES_DISABLED` and the workspace hides the toggle) and `file_audit_enabled` (default false). With the audit on, the daemon writes `file.upload` and `file.download` (path, size), `file.mkdir`, `file.rename` (from, to) and `file.remove` (paths, count) to `audit_events`, with the client's address and user agent; file contents are never logged.

**UI.** The toggle lives on the pane it opens (D-39): the tab row's **Files** button for a tab with one pane, a folder button in each pane caption of a split, a button in the phone's pane header. The panel docks at the pane's trailing edge (resizable; when the pane cannot keep a usable terminal beside it, the panel covers that pane's terminal instead), so opening it resizes that session only. On a phone it is a full-screen view with the way back to the terminal. Navigation (the path bar) is always at the top, then the actions (Upload, New folder, the terminal's folder, hidden files, Refresh), then what the selection can do. Open state, width, folder and the hidden-files toggle (on by default) live in the browser tab only (no persistence). Uploads (several files, from the picker or dropped on the panel) and downloads (several files, one browser download each, handed to the browser one after another) run two at a time per browser tab and keep running when the panel closes; a name already in the folder asks once: replace, keep both (`name (1).ext`) or skip. Delete is always confirmed. Components and states: `apps/web/DESIGN.md`, "File panel".

---

## 6. tmux integration specification

### 6.1 Why control mode

In control mode tmux draws **nothing**: no status line, no prefix key, no copy-mode UI. It sends the application's raw output as structured `%output` notifications and accepts commands on stdin. Termdock feeds that output into its own emulator, so the browser gets **native scrollback** and full fidelity while connected. On (re)attach it reconstructs screen, history and modes with `capture-pane` and format queries. This is the only option that meets D-04/D-10 ("invisible"). Normal mode can only feed the emulator tmux's *re-render*, which structurally breaks browser scrollback. Normal mode stays as a compatibility fallback (§6.11).

### 6.2 Version gates

| tmux | Behaviour |
|---|---|
| absent | `none` |
| < 3.2 | `tmux-normal` (P7) |
| 3.2 – 3.6 | `tmux-control`. On reattach, bracketed-paste state (needs 3.7), extended-key mode (3.5) and cursor style (3.6) are unknown → heuristic defaults. |
| ≥ 3.7 | `tmux-control` with full mode recovery. 3.8 adds `pane_private_modes` and fixes several control-client bugs. |

### 6.3 Launch

Naming: socket `td-<installationId[0:8]>-<session.tmuxToken>`, where `tmuxToken` is 12 lowercase base32 chars stored on the session. Session name `main`. Names stay within `[a-z0-9-]`.

```sh
# Sent over an SSH exec channel (no PTY) as:  exec sh -c '<script>'   (§5.11 remote command rule)
# Example <script>, with values from the probe and the session:
#   tmux_path=/usr/bin/tmux · utf8_locale=C.UTF-8 · scrollback_lines=5000 · server env EDITOR=vim
# `exec /usr/bin/tmux` becomes `exec systemd-run --user --scope --quiet /usr/bin/tmux` only under the §5.11 logind rules.
export LC_CTYPE=C.UTF-8
exec /usr/bin/tmux -u -L td-1a2b3c4d-k3j9x2m8q0wz -f /dev/null -C \
  start-server \; \
  set-option -g history-limit 5000 \; \
  set-option -g default-terminal tmux-256color \; \
  set-option -g aggressive-resize off \; \
  set-option -g detach-on-destroy on \; \
  set-option -g window-size latest \; \
  set-option -g status off \; \
  new-session -A -s main -x 120 -y 40 -e EDITOR=vim \
    "exec env -u TMUX -u TMUX_PANE \"\$SHELL\" -l"
```

Notes and rules:

- **Always `-u`, and export `LC_CTYPE`.** Without `-u`, command output is sanitized to `_` for non-ASCII when the exec channel has no UTF-8 locale. The remote tmux server also needs a UTF-8 locale: the launch exports `LC_CTYPE=<utf8_locale>` from the probe.
- **Absolute tmux path** from the probe (`tmux_path`), so the launch does not depend on the PATH of a non-login `sh`.
- `history-limit` = the session's `scrollback_lines` (from the server; never hard-coded).
- `-f /dev/null` applies only when this invocation starts the server. Options are re-applied harmlessly on reattach. Exact quoting and option ordering **[SPIKE S2]**.
- `default-terminal`: use `tmux-256color` if the probe found its terminfo, else `screen-256color`.
- **Pane command**: `exec env -u TMUX -u TMUX_PANE "$SHELL" -l`, or, with a startup command, `exec env -u TMUX -u TMUX_PANE "$SHELL" -lc '<quoted startup>'`. Profile env vars (`env_json`) are passed as `new-session -e KEY=VALUE`, one per variable.
- `env -u TMUX -u TMUX_PANE` lets the user run their **own** `tmux` inside a Termdock session without the "sessions should be nested with care" warning. Their tmux uses the default socket, fully separate from ours. **[SPIKE S5]**
- One tmux server per Termdock session gives isolation (options, crash blast radius), and `terminate` is a simple `kill-server` on that socket.

### 6.4 Protocol parser requirements

- Split stdout on `\n` **at the byte level**; never decode a line as text before unescaping.
- `%begin <time> <num> <flags>` … `%end|%error <time> <num> <flags>`: a block ends only on a guard line with the **same** time/num/flags triple. Every other line inside a block is data, even if it starts with `%`.
- Correlation is FIFO: one queue entry per *command*. A `%begin` with `flags & 1` pops the head. Blocks with `flags = 0` are unsolicited (e.g. the initial `new-session`) and are consumed without popping.
- `%output %<pane> <data>`: bytes < 0x20 and `\` arrive as `\ooo` (exactly 3 octal digits); every other byte is raw. Unescape to a `Uint8Array`. Multi-byte UTF-8 sequences and escape sequences may span two `%output` lines; the emulator's streaming UTF-8 decoder handles that.
- `%extended-output %<pane> <age> … : <data>` (when `pause-after` is set): the payload starts after the first ` : ` following `<age>`. Watch `age` for early lag warnings.
- Handle `%exit [reason]`, `%pause`/`%continue`, `%session-changed`, `%window-add`/`%window-close`, `%window-pane-changed`, `%layout-change`, `%pane-mode-changed`, `%client-detached`, `%config-error` (3.4+), `%message`.
- The driver tracks the session's **active pane id**. If windows or panes change because the user ran tmux commands against our server, it follows the active pane and resyncs. Termdock never exposes tmux windows or panes: Termdock splits are separate sessions.
- Any parse inconsistency → `onDesync()`: kill **our control client only** (never the tmux session), reattach, full resync.

### 6.5 Input

- Input bytes → `send-keys -H -t %<pane> <hex> <hex> …` (one byte per argument). This is safe for C0, ESC, DEL, UTF-8 and bracketed-paste markers, and it bypasses `escape-time`.
- Coalesce keystrokes for 2–5 ms. Chunk large pastes at ≤ 1 KiB of input per command. Pipeline commands without waiting for replies.
- If the pane is in a mode (`#{pane_in_mode}` / `%pane-mode-changed`), first send `send-keys -X -t %<pane> cancel`.
- Bracketed paste is applied by the browser's xterm.js (it saw `?2004h` in the raw output); the bytes pass through unchanged.

### 6.6 Resize

`refresh-client -C <cols>x<rows>` (valid on ≥ 3.2). The resulting `%layout-change` confirms the pane size; the driver reports that **pane** size with `ctx.resized()`, and the runtime resizes the emulator through the write queue and sends a `SNAPSHOT` to every attachment (§5.5). Keep `aggressive-resize off` (iTerm2 refuses to run with it on).

### 6.7 Flow control

- On attach: `refresh-client -f pause-after=5` (always N ≥ 1).
- Ingest backpressure: the exec channel is paused and resumed with the same 8 MiB / 1 MiB rule as the other drivers (§5.5). While it is paused the SSH window fills, tmux's output age for the pane grows, and `pause-after` engages.
- On `%pause %<pane>`: send in one line `refresh-client -A '%<pane>:continue' ; <snapshot batch §6.8>`, rebuild through `ctx.replaceState()`, and resync every attachment. S4 measures the cost of these rebuilds.
- Without `pause-after`, tmux ≥ 3.2 kicks a client that is 300 s behind (`%exit too far behind`); with it, this cannot happen.
- tmux 3.8 caps buffered command replies at 64 MiB. Page very large histories by range (`-S -20000 -E -10001` …) using `#{history_size}`.

### 6.8 Snapshot and restore algorithm

Attaching sends no screen content; Termdock must capture it. Send as **one line** so the commands run back to back:

```text
capture-pane -p -e -J -N -t %3 -S - -E -1 ; \
capture-pane -p -e -J -N -t %3 ; \
capture-pane -p -e -J -N -a -q -t %3 ; \
display-message -p -t %3 '<STATE_FORMAT>' ; \
capture-pane -p -P -C -t %3 ; \
display-message -p 'td-<random nonce>'
```

- History (`-S - -E -1`) and the visible screen (default range) are captured **separately**, with SGR (and OSC 8 links on 3.4+). `-J` joins wrapped lines, which changes line counts, so the split between history and screen is never inferred by counting lines of a single capture.
- `-a -q`: the saved main screen when the alternate screen is active (empty otherwise).
- `STATE_FORMAT`: TAB-separated `pane_id pane_width pane_height history_size cursor_x cursor_y alternate_on alternate_saved_x alternate_saved_y scroll_region_upper scroll_region_lower cursor_flag insert_flag keypad_cursor_flag keypad_flag wrap_flag origin_flag mouse_standard_flag mouse_button_flag mouse_any_flag mouse_sgr_flag mouse_utf8_flag pane_in_mode pane_tabs bracket_paste_flag pane_key_mode cursor_shape cursor_blinking pane_private_modes #{q:pane_title}`. `pane_title` is **last** and quoted with `#{q:…}`, so a title containing tabs cannot shift the other fields. Unknown variables expand to empty on older versions.
- `-P -C`: any incomplete escape sequence still pending in tmux's parser, used to prime ours.
- **Batch terminator.** Every snapshot batch ends with `display-message -p 'td-<random nonce>'` (a fresh nonce per batch). The driver accepts the batch only when the final block's output equals that nonce; anything else is treated as a desync (§6.4). This defends against pane content that forges guard lines.

Rebuild into a **fresh** headless terminal, through `ctx.replaceState()` (the runtime creates the fresh emulator, the driver fills it, the runtime swaps it in):

1. The runtime creates the terminal at the pane size, with scrollback = the session's `scrollback_lines` (= `history-limit`).
2. Write the history lines, then the screen lines, joined by `\r\n` (no trailing newline). Track the SGR pen across lines and emit `\e[0m\r\n<pen>` so background-colour-erase does not paint scrolled lines.
3. Re-apply modes: DECCKM `?1h`, keypad `ESC =`, mouse `?1000/1002/1003/1005/1006h`, `?2004h`, `?25l`, IRM `CSI 4h`, `?7l`, `?6h`, scroll region (before CUP), tab stops (`CSI 3 g` + HTS), DECSCUSR. The mode tracker records them (§5.3.1).
4. Finish with CUP to `cursor_y+1;cursor_x+1`. When origin mode is on (`origin_flag`), CUP is relative to the scroll region, so the row sent is `cursor_y - scroll_region_upper + 1`.
5. If the alternate screen is active: write history + the `-a` main screen, CUP to the saved cursor, `\e[?1049h`, paint the alternate rows, CUP.
6. The runtime swaps the rebuilt terminal in as the session emulator and resyncs all attachments (snapshot per §5.4).

**Snapshot boundary [SPIKE S3 — highest risk].** tmux queues `%output` for control clients *before* parsing the same bytes into its grid, and command replies queue behind pending `%output`. So every `%output` received **before** the capture's `%begin` is already contained in the capture and must be dropped; only `%output` after the block's `%end` is applied. This is derived from tmux source, not documented, and must be proven under heavy output (`yes`, `seq 1 10000000`) with golden tests.

**Unrecoverable state** (accepted limitations, documented to users): current SGR pen, G0/G1 charsets, DECSC saved cursor (only the alt-saved cursor is exposed), pending-wrap flag, sixel/images, kitty keyboard state, and mode flags not exposed by the remote's tmux version (§6.2). Wide-character width may differ between tmux's tables and xterm.js. This affects reattach-after-reconnect only; plain browser reattach uses the emulator and is exact for buffer, cursor and the tracked modes (§5.3.1).

### 6.9 Queries in control mode

tmux's own emulator answers the application's queries, so both the server emulator and the browser run the query silencer (§5.3). tmux ≥ 3.5 lets a control client supply OSC 10/11 colours via `refresh-client -r`. Termdock sends the theme's foreground/background so color-aware programs behave.

### 6.10 Lifecycle edge cases

| Case | Handling |
|---|---|
| Stale Termdock control client (old connection not yet dead) | After attach: `list-clients -F '#{client_name} #{client_control_mode} #{client_pid}'`; `detach-client -t` any other control-mode client on our socket. Never `new-session -D` (it would also detach humans). |
| Remote host rebooted (tmux silently recreated by `-A`) | Record `#{session_created}` and `#{pane_pid}` on first attach. A mismatch on reattach → banner "remote host restarted · previous shell lost" + event. |
| systemd-logind `KillUserProcesses=yes` (tmux killed when our SSH login session ends) | The probe reads `KillUserProcesses` (`busctl`) and linger (`loginctl`); launch per the §5.11 logind rules. With `KillUserProcesses=yes` and linger on, launch via `systemd-run --user --scope --quiet`; with linger off there is no reliable protection, and the UI and host diagnostics show "remote may kill tmux on disconnect — enable linger". **[SPIKE S5]** |
| tmux socket deleted from `/tmp` | Detect "no server running" with the remote session previously alive → try `pkill -USR1 -u $(id -u) -f 'tmux.*-L td-…'` to recreate the socket, then reattach. Otherwise treat as a remote reboot. |
| User runs `tmux` inside the session | Works: `TMUX` is unset in our pane, and theirs uses the default socket. |
| `%exit` received | `%exit` also happens on `detach-client`, "too far behind" and tmux server death, so it does not by itself mean the shell exited. Before declaring `ended`, confirm with a fresh exec `<tmux_path> -L <socket> has-session -t main`: non-zero → `ended` (reason `shell_exited`); zero → reattach (the session lives on). |
| Exec channel EOF without `%exit` | Transport-loss path (§5.7): reconnect and reattach. |
| Terminate requested | `kill-server` on our socket, then close the transport. Not connected: a one-shot connection does it (§5.8, D-30). |

### 6.11 Normal-mode fallback (Phase 7)

For tmux < 3.2. Inside a PTY with `TERM=xterm-256color`, start `<tmux_path> -u -L <socket> -f <generated conf> new-session -A -s main <pane command>`, wrapped and with `LC_CTYPE` exported exactly as in §6.3 (same pane command, same `-e KEY=VALUE` env vars), where the generated conf contains:

```text
set -g status off
set -g prefix None ; set -g prefix2 None
unbind-key -a ; unbind-key -a -T root
set -g mouse off
set -s escape-time 10
set -g history-limit <scrollback_lines>              # the session's scrollback_lines
set -g default-terminal tmux-256color          # or screen-256color
set -ga terminal-overrides ',xterm-256color:Tc'
set -ga terminal-overrides ',xterm-256color:smcup@:rmcup@'
set -g set-titles on ; set -g set-titles-string '#T'
set -g visual-activity off ; set -g visual-bell off ; set -g monitor-activity off
set -g aggressive-resize off ; set -g detach-on-destroy on
```

The conf is written once to `~/.cache/termdock/<socket>.conf` via exec; this is the only file Termdock writes on remotes, and it is documented. Known limitations: browser scrollback while connected is unreliable, and after a restart only the visible screen is exact (history best-effort via `capture-pane` before attach). The UI badge shows "Protected (compatibility mode)".

### 6.12 Remote leftovers (D-30)

A protected session's tmux server outlives Termdock by design (§5.8). It is left behind only when Termdock forgets it: a database reset, or a terminate whose remote cleanup failed (§5.8). The daemon finds these servers and ends or offers them (`core/remote-sessions.ts`, `internal-api/remote-sessions.ts`).

**Scan.** `scanSocketsCommand` (`drivers/tmux-control/commands.ts`), sent as one line through the remote command rule (§5.11) on an exec channel without a PTY (`t` = the probe's tmux path):

```sh
d="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"; [ -d "$d" ] || exit 0; n=0
for f in "$d"/td-*; do
  [ -S "$f" ] || continue; s=${f##*/}
  expr "x$s" : 'x[a-z0-9-]*$' >/dev/null || continue   # nothing that could split a line
  l=$("$t" -L "$s" list-sessions -F '#{?#{==:#{session_name},main},1,0} #{session_created} #{session_activity} #{session_attached}' 2>/dev/null) || continue
  m=$(printf '%s\n' "$l" | grep '^1 ' | head -n 1)
  [ -n "$m" ] || m=$(printf '%s\n' "$l" | head -n 1); [ -n "$m" ] || continue
  set -f; set -- $m; set +f; printf '%s\t%s\t%s\t%s\n' "$s" "$2" "$3" "$4"
  n=$((n+1)); [ $n -gt 200 ] && break
done; exit 0
```

- One line per socket whose server answers: its name, `session_created`, `session_activity` (epoch seconds) and `session_attached` (clients), for the session `main`, or the first one if there is no `main`. Only numbers leave the host: no session name, pane command or title is read. A socket whose server does not answer is skipped; nothing is started (`list-sessions` never starts a server), killed or removed. Verified on tmux 3.2a, 3.4 and edge (T1).
- **Parser** (untrusted host output, §10.2): stdout read up to 64 KiB (beyond: `truncated`, the partial last line dropped), lines over 256 characters dropped, exactly four tab-separated fields, a name matching `REMOTE_SOCKET_PATTERN` (`td-` + 1–8 of `[a-z0-9]` + `-` + 12 of `[a-z2-7]`; anything else is ignored), no duplicate; times seconds → ms (null when absent, zero or not a number), an unreadable client count 0; at most 200 entries (`truncated`).

**Classification** against the session records of every user, with this installation's prefix computed by the same code that names the sockets (`tmuxSocketPrefix`, §6.3). A session's socket is its `tmux_socket` (adopted, §9) or `td-<prefix>-<tmux_token>`. In order:

1. it belongs to a session that is not `ended`, of any user → hidden, never touched;
2. it belongs to an ended session of another user → hidden, never touched;
3. it belongs to an ended session of the acting user → a **leftover**, ended at once (below); listed with origin `ended` (and its session id and label) only when that fails;
4. no record: this installation's prefix → `unknown`; any other prefix → `other` (another installation, or this one before a database reset: the installation id lives in the database, so telling them apart is left to the user).

**Safety rules.** Right before each leftover kill the socket is classified again (writes still queued in the batched writer included) and skipped unless it still belongs only to an ended session of the acting user that ended at least 60 s ago: Reopen keeps the tmux token and `new-session -A` reattaches a surviving server, so a Reopen (or an adoption) in between wins. A skipped leftover is neither killed nor listed. A kill is `killServerCommand` (§6.3) and records `remote_cleanup` (`source`: `sweep`, `scan` or `manual`) on the ended session. There is no time-based expiry: an `unknown` or `other` server stays until the user ends or adopts it.

**Background sweep.** When a session reaches `ready`, its attempt's own connection runs the scan on an extra exec channel, detached: it never delays or fails the session, stops when the attempt ends, and its errors are only logged. Leftovers are ended as above. When `unknown` or `other` servers exist, the owner gets `server.remote_sessions { serverId, serverName, count }` (§7.3), at most once per daemon run per server and set of sockets. At most one sweep per process every 15 min per (user, normalized hostname, port, user name on the server). A session whose server was deleted never sweeps (it never connects, D-29).

**Server page** (internal API, §8.3). Each call opens a connection of its own, as the server test does (§5.9): the server's user name and stored credential, its address's trusted key, never a prompt. Without a stored credential nothing is contacted (`CREDENTIAL_REQUIRED`); an unknown key is recorded as `pending` for the address exactly as the server test does (`HOST_KEY_REJECTED`); a mismatch or a revoked key is audited (`HOST_KEY_MISMATCH`). Lists and ends share a limit of 20 per user and minute, and each call closes its connection 25 s after the request at the latest (web waits 30 s).

- **List**: probe (for the tmux path), scan, classify, end the leftovers (kills start within 20 s of the request; one left out is listed as `ended`), and answer the rest sorted `ended`, `unknown`, `other`, with `cleaned` and `truncated`. Why it could not list goes in `error`, with an empty list.
- **End** (`{ socket }`): refused (`409`) for classes 1 and 2, checked again right before the kill; `terminated: false` when no server answers for the socket; otherwise `killServerCommand`. Audited `remote_session.terminated { socket, origin }`; an `ended` one also records `remote_cleanup` on its session. A failure to connect, sign in or ask the host is `502 { code }`, with the codes a list reports.
- **Adopt** (`{ socket, label? }`): a new session of the server, created exactly as `POST /sessions` creates one (target snapshot, label defaulting to the server's name, the running-session cap), plus `tmux_socket = socket`, protection `tmux-control` preset (so the runtime attaches instead of selecting) and `last_ready_at` set (Restoring, not Connecting). It starts at 120×40 until a viewer attaches. It is classified inside the insert's transaction, so one socket is never adopted twice: classes 1 and 2 are refused (`409`), and so is class 3 (the leftover of one of the user's own ended sessions: Reopen that session, which reattaches it). Clients attached to the server do not prevent it (web asks first). Audited `remote_session.adopted { socket, origin, sessionId }` in the same transaction. The runtime launches on that socket: `new-session -A -s main` attaches and takes the rebuild path (§6.8); when the launch's created marker shows the session was gone, the new shell stays and the event `adopt_target_gone` is recorded. Reopen keeps `tmux_socket`.

**End all sessions** (`POST /sessions/terminate-all`, a step before any database reset in the upgrade guide): every non-ended session of the acting user starts ending, 4 at a time (each is `terminating` from its start), and the call answers once each is ending, waiting for the ends at most 3 s in total; remote cleanups continue after it (§5.8). The admin's `users/:id/terminate-sessions` does the same for its target user.

### 6.13 Foreground command (D-33)

The driver reports the pane's foreground command to the runtime. With `automatic-rename` on (tmux's default, untouched by `-f /dev/null`), tmux names the window after `#{pane_current_command}`, the program owning the pane's terminal, and sends `%window-renamed` when it changes; tmux checks after pane output, which is enough for a program that draws, such as tmux, so there is no polling. The driver takes the name from that notification. tmux 3.2a to 3.4 hold a rename made within 500 ms of the previous name check until the next event reaches the server, and starting a program from the prompt is exactly that case (measured on 3.2a: the rename came 10 s later, with the next event; 3.8 sends it at once). So the driver also asks with `display-message -p '#{pane_current_command}'` one second after each Enter in the input: the command is itself an event, and its reply comes at once. It asks the same way after every start (after a daemon restart a program may already run) and when the active pane changes. No timer runs while nobody types. The runtime turns `tmux` into the `nested_tmux` hint (`terminal.hint`, §7.3) and clears it when the command changes or the session leaves `ready`.

---

## 7. WebSocket protocol v1

One WebSocket per browser tab, multiplexing every attachment of that tab over numeric **channels**. Control messages are JSON text frames; terminal data uses binary frames. The protocol lives in `packages/protocol` (types + codec + tests) and is the shared contract between `web` and `session-manager`.

### 7.1 Connection and authentication

1. The browser calls `POST /api/ws/ticket` (cookie-authenticated; the response carries `Cache-Control: no-store`) → `{ ticket, expiresAt }`. The issuer refuses while the user has a pending TOTP enrollment or a pending forced password change (§10.2).
2. It opens `wss://<origin>/ws`. session-manager checks the `Origin` header against `TERMDOCK_PUBLIC_URL`; mismatch → close `4403`.
3. The first frame must be `hello` within 5 s: `{ "type": "hello", "protocol": 1, "ticket": "…" }`.
4. Ticket = `base64url(payload) "." base64url(HMAC-SHA256(ws_secret, payload))`, with payload `{ v: 1, uid, asid, exp, nonce }`, TTL 30 s, **single use** (nonce kept in an LRU until `exp`). The key `ws_secret` is the trimmed content of the file named by `TERMDOCK_WS_SECRET_FILE`, as UTF-8 bytes (never base64-decoded); web and session-manager read the same file.
5. The server verifies that the auth session `asid` exists and is not expired (it reads the auth-session table) and that the user is not `banned`, binds the connection to `uid`, and replies `hello.ok`.
6. Revalidation (auth session still valid, user not `banned`) every 60 s, and immediately on `POST /internal/v1/auth-sessions/revoke`. A revoked connection is closed with `4401`.
7. **Sliding the auth session.** Terminal traffic goes over the WebSocket and never touches Next.js, so while a workspace is open the web client calls Better Auth's get-session every 10 min; that keeps the 7-day sliding expiry (§10.2) moving.

**Limits:** ws `maxPayload` is 1 MiB for client→server frames; at most 32 channels per connection (one more attach closes the connection with `4400`, §10.2); at most 50 running sessions per user (instance setting, enforced at session creation, §8.3).

### 7.2 Binary frames

```text
offset  size  field
0       1     type     0x01 OUTPUT (S→C) · 0x02 INPUT (C→S) · 0x03 SNAPSHOT (S→C)
1       1     flags    bit0 = payload gzip-compressed (SNAPSHOT only)
2       4     channel  u32 big-endian
6       8     seq      u64 big-endian (OUTPUT: last chunk seq · SNAPSHOT: snapshotSeq · INPUT: 0)
14      2     cols     u16 big-endian (SNAPSHOT only)
16      2     rows     u16 big-endian (SNAPSHOT only)
14|18   …     payload  OUTPUT/INPUT (offset 14): raw terminal bytes · SNAPSHOT (offset 18): UTF-8 serialized state + mode epilogue
```

The header is 14 bytes for `OUTPUT`/`INPUT` and 18 bytes for `SNAPSHOT`. Snapshots are gzip-compressed on the server and decompressed in the browser with `DecompressionStream('gzip')`. A `SNAPSHOT` always replaces client state completely, including its size (§5.4, §5.5).

### 7.3 Control messages

Client → server:

| type | fields | notes |
|---|---|---|
| `hello` | `protocol, ticket` | first frame |
| `session.attach` | `channel, sessionId, viewport {cols, rows}` | server checks ownership → `4403`-style `error` if not owned |
| `session.detach` | `channel` | |
| `terminal.viewport` | `channel, cols, rows` | the attachment's fitted size changed |
| `terminal.activate` | `channel` | focus/click → becomes the active attachment |
| `terminal.resync` | `channel` | asks for a fresh `SNAPSHOT` (e.g. after a decode error) |
| `hostkey.decision` | `sessionId, fingerprint, accept` | accept trusts exactly the pending key with that fingerprint (§5.9) |
| `auth.response` | `sessionId, promptId, answers: string[]` | never logged; a stale `promptId` is discarded (§5.10) |
| `files.request` | `requestId, sessionId, request` | file panel (§5.12): `request.op` is `open`, `list`, `mkdir`, `rename`, `remove`, `upload` or `download`; ownership checked like an attach; answered by one `files.result` |
| `files.cancel` | `requestId` | stops a running request (a `remove`) |
| `transfer.cancel` | `transferId` | stops an upload or download, or voids its unused URL |
| `ping` | `t` | app-level keepalive every 25 s |

Server → client:

| type | fields |
|---|---|
| `hello.ok` | `protocol, userId, serverTime` |
| `sessions.list` | full list of the user's sessions with `status`, `protection`, labels (sent after `hello.ok`) |
| `session.upsert` / `session.removed` | incremental list updates (also used for sessions created in another tab) |
| `session.status` | `sessionId, status, state, detail?, retryInMs?, attempt?, maxAttempts?, retryUntil?, remoteCleanup?` — `attempt`/`maxAttempts` (a session that never connected) or `retryUntil` (epoch ms, one that lost its connection) on every status of a retry round (D-31, §5.7); `remoteCleanup: 'pending'` only with `ended`: the session's tmux could not be ended now (§5.8). Both live only, not part of the summary |
| `session.attached` | `channel, sessionId, cols, rows, scrollbackLines` (followed by a `SNAPSHOT` frame; the browser sizes its scrollback from `scrollbackLines`) |
| `terminal.resized` | `channel, cols, rows, seq, activeAttachment: boolean` — the client resizes after applying every `OUTPUT` with `seq <= seq` and before later ones (§5.5) |
| `terminal.title` | `channel, title` (sanitized, ≤ 256 chars) |
| `terminal.bell` | `channel` |
| `terminal.hint` | `channel, hint: 'nested_tmux' \| null` — a pane tip while its condition holds (D-33, §6.13); sent on change and right after `session.attached`, which itself clears any earlier hint |
| `hostkey.prompt` | `sessionId, keyType, fingerprint, mismatch` |
| `auth.prompt` | `sessionId, promptId, name, instructions, prompts: [{ text, echo }]` |
| `server.remote_sessions` | `serverId, serverName, count` — a session's connection found Termdock tmux servers on its server that no session record knows (§6.12); at most once per daemon run per server and set of sockets |
| `files.result` | `requestId, result? \| error? {code, message}` — exactly one of them (§5.12) |
| `files.progress` | `requestId, removed` — a `remove` in progress |
| `transfer.progress` | `transferId, bytes, size, state, code?` — to the connection that minted the URL: at the start, at most four per second, at the end |
| `server.shutting_down` | `expectedBackInMs?` |
| `error` | `code, message, channel?, sessionId?` |
| `pong` | `t` |

Session summaries (`sessions.list`, `session.upsert`) carry `statusDetail`: the `detail` of the session's latest `session.status` (failure code, end reason, `remote_rebooted`), so a reloaded page still says why; after a daemon restart a `failed` session's code comes from its last `state_changed` event. `session.upsert` is also sent whenever a summary field changes (protection selected or degraded, first ready, end, reopen).

Close codes: `4400` bad request · `4401` unauthenticated/revoked · `4403` forbidden/bad origin · `4409` protocol version unsupported · `4429` rate limited · `4500` internal.

Evolution: additive changes stay in v1 (receivers ignore unknown fields and unknown message types). Breaking changes bump `protocol`.

---

## 8. Control plane (web app)

### 8.1 Routes

| Route | Purpose |
|---|---|
| `/setup` | First-run only: create the first admin. Requires the one-time **setup token** printed in the web logs at boot while no user exists. Returns 404 afterwards. |
| `/login`, `/login/two-factor` | Username/password, then TOTP (with "trust this device for 30 days"). A pending forced password change (`must_change_password`) or required TOTP enrollment (`totp_required` or the instance-wide requirement) is completed before any other page opens. |
| `/workspace` | The terminal workspace (§11). Default landing page. "End all sessions…" at the foot of the session list (D-30); a notice links to a server page when a session's connection found Termdock tmux servers this installation does not run. |
| `/servers` | The user's servers (D-29): name, `user@address` (`:port` when not 22), the credential or "None", Edit and Duplicate. With none yet, the empty state leads to Add server and the Docker host preset. |
| `/servers/new` | **Add server** (D-27, D-29): two sections in one form. Server: name, address, port (22), user name on the server (the `local` kind only for admins when the instance allows it, without address, user or credential), and the options behind an "Advanced" disclosure (protection, startup command, env, keepalive, scrollback, auto-reopen). Credential: generate a key (recommended), paste a key (+ passphrase), a password, a saved credential, or none (the server asks for the password in the terminal); the name defaults to `<user>@<server name>`. Validates everything first, creates a new credential through the daemon, then inserts the server, and deletes that credential again if the insert fails. The result shows in place: the public key, install command and fingerprint of a generated key (the fingerprint of a pasted one), "Start a session" (opens `/workspace?open=<sessionId>`), the way back and the server's page. `?duplicate=<id>` prefills every field from one of the user's servers (name + " (copy)", the same credential or none; another user's id gives an empty form); nothing is written until the user saves. Links to the Docker host preset. |
| `/servers/[id]` | A server's page: edit every field (credential: a saved one or none, with a "New credential" link that returns here), Duplicate, and delete (rejected while a non-ended session came from it, §8.2). Diagnostics for SSH servers: "Test connection" (reachability, host key, probe summary; the probe needs a stored credential to sign in) and the host keys of the server's address (trust a pending key, pre-trust a fingerprint, replace after a mismatch by typing the address, revoke). A decision applies to all of the user's servers at that hostname and port (§5.9). "Sessions on this server" (D-30, §6.12, SSH servers only): "Check now" lists the Termdock tmux servers this installation does not run, with End and Adopt (a leftover of the user's own ended session links to the workspace instead, where Reopen reattaches it). |
| `/servers/docker` | "Add this Docker host" preset (§13.4): a generated key plus a server `user@host.docker.internal:22` that uses it. |
| `/credentials` | Create (password / paste private key / **generate ed25519 key** and show the public key), rename, delete (rejected while referenced by a non-ended session). Secrets are never displayed after creation. |
| `?from=` | Return path (D-27) on `/servers/new`, `/servers/[id]` and `/credentials`: a "Back to …" link to an allowlisted in-app page (`/workspace`, `/servers`, `/servers/new`, `/servers/[id]`, `/credentials`, matched whole by `safeReturnPath`; anything else is dropped). The first-run panel, the servers list, Duplicate, the server page's "New credential" link and the palette carry it. |
| `/activity` | The user's own session history and events. |
| `/settings/account` | Password, TOTP enroll/disable, language, theme. |
| `/settings/terminal` | Font, size, color scheme, cursor, clipboard (OSC 52) permission, link-opening confirmation. (Scrollback is set per server, §5.3.) |
| `/admin/users` | Create users (temporary password with a forced change on first login — `must_change_password`; role; require TOTP — `totp_required`), disable/enable (Better Auth admin plugin `banned`; disabling revokes the user's auth sessions and closes their WebSockets, while their terminal sessions keep running unless the admin ticks "also terminate sessions"), reset TOTP, revoke auth sessions. |
| `/admin/settings` | Instance settings (`instance_settings`, §9): require TOTP for everyone (`require_totp`), maximum running sessions per user (`max_running_sessions_per_user`, default 50), local direct-mode visibility (`local_shell_visible`; only effective with the daemon flag on, once direct mode ships in Phase 6), file transfer (`file_transfer_enabled`, default on) and the file operations log (`file_audit_enabled`, default off; D-39, §5.12). There is no idle-timeout setting: web auth sessions use the 7-day sliding expiry (§10.2). |
| `/admin/audit` | Audit log viewer with filters. |

### 8.2 Server API

- Mutations from forms use **Server Actions** (built-in origin check), validated with zod; every action re-checks ownership.
- Route handlers: `/api/auth/[...all]` (Better Auth; over HTTP only `GET /api/auth/get-session`, T-15), `POST /api/ws/ticket` (`Cache-Control: no-store`, §7.1), `/api/layout`, `/api/health`.
- **Layout API, optimistic concurrency.** `GET /api/layout` returns the layout and its `version`. `PUT /api/layout` carries `If-Match: <version>`; a mismatch → `409`, and the client reloads the stored layout and re-applies its change.
- Session creation, rename, termination, retry and reopen: Server Action → internal API (§8.3). The UI receives the result via `session.upsert` on the WebSocket.
- **Deletes vs live sessions.** Deleting a host, profile or credential that is referenced by a non-ended session is rejected with `409 CONFLICT`; the user terminates those sessions first. Edits are always allowed: a session snapshots its target at creation (§9), so target edits affect only new sessions (policies are read live, §9).

### 8.3 Internal API (session-manager `:3002`)

Bearer token: the trimmed content of the file named by `TERMDOCK_INTERNAL_TOKEN_FILE` (`Authorization: Bearer <token>`, the same file web reads), compared in constant time; a missing or wrong bearer → `401`. JSON; zod schemas in `packages/protocol/internal`. Every user-scoped call carries `actingUserId` (in the body, or in the query string for `GET`), and session-manager re-validates ownership against the DB. **Exceptions:** `POST /internal/v1/auth-sessions/revoke` (an admin/system action addressed by auth-session id or user id) and `GET /internal/v1/health`.

| Method & path | Body → Result |
|---|---|
| `POST /internal/v1/sessions` | `{ actingUserId, serverId, label?, viewport }` → `{ sessionId }`. The server must belong to the acting user (else `404`), and so must its credential, if any. Snapshots the target from the server (§9; a local session: `localhost`, port 0, no user name) and links the session to it (`server_id`; the `created` event's detail is `{ serverId }`). Rejected when the user already has the maximum number of running sessions (instance setting, default 50), and for `kind: local` when direct mode is off or the acting user is not an admin. Without `label` the session takes the server's name; a given label follows the rename rules below. |
| `PATCH /internal/v1/sessions/:id` | `{ actingUserId, label }` → `{ sessionId, label }` with the label as stored (D-28). Control characters and invisible formatting (bidi controls, zero-width characters) are dropped with the stripper used for terminal titles and keyboard-interactive prompts, then the label is trimmed and must keep 1–120 characters, else `400 LABEL_INVALID`. Allowed in every state, `ended` included. Audited as `session.rename` (`{ previousLabel, label }`); every WebSocket of the owner gets a `session.upsert`. |
| `POST /internal/v1/sessions/:id/terminate` | `{ actingUserId }` → `204` (`desired_state = terminated`). Answers within 3 s: a remote cleanup still running then (the session was not connected, §5.8) ends the session later, through `session.status`. |
| `POST /internal/v1/sessions/terminate-all` | `{ actingUserId }` → `{ terminated }` ("End all sessions", D-30): every non-ended session of the acting user starts ending (4 at a time); answers once each is ending, waiting for the ends at most 3 s in total (§6.12). |
| `POST /internal/v1/sessions/:id/retry` | `{ actingUserId }` → `204`. Restarts the connect loop with the same `tmux_token` (reattaches the same tmux session); skips any remaining backoff wait ("Retry now"); a waiting session starts a fresh round (D-31). A session whose server was deleted → `404 NOT_FOUND` ("server was deleted"). |
| `POST /internal/v1/sessions/:id/stop` | `{ actingUserId }` → `204` (D-31). Ends the session's retry round: it waits as `failed` (`RETRIES_STOPPED`) for Retry or End. `409 CONFLICT` unless the connect loop is trying (connected, ended, or waiting for the user already). |
| `DELETE /internal/v1/sessions/:id` | `{ actingUserId }` → `204` (D-32). Deletes an ended session with its `session_events`, audited `session.remove`; its viewers' channels end with `error NOT_FOUND`, and the owner gets `session.removed`. `409 CONFLICT` when it has not ended. |
| `POST /internal/v1/sessions/remove-ended` | `{ actingUserId }` → `{ removed }` (D-32). Deletes every ended session of the acting user the same way. |
| `POST /internal/v1/sessions/:id/reopen` | `{ actingUserId }` → `{ sessionId }`. New shell, same id, new runtime; `desired_state` back to `running`. Only for `ended` sessions or sessions with protection `none`; otherwise `409 CONFLICT`. A session whose server was deleted → `404 NOT_FOUND` ("server was deleted"), nothing changes. |
| `GET /internal/v1/sessions?actingUserId=` | → live runtime statuses (authoritative) |
| `POST /internal/v1/credentials` | `{ actingUserId, name, kind: 'password', password }` · `{ actingUserId, name, kind: 'private_key', privateKey, passphrase? }` · `{ actingUserId, name, kind: 'generate', algorithm: 'ed25519' }` → `{ credentialId, publicKey, fingerprint }` (`publicKey`/`fingerprint` null for passwords) |
| `PATCH /internal/v1/credentials/:id` | `{ actingUserId, name }` → `204` (rename; the only mutable field) |
| `DELETE /internal/v1/credentials/:id` | `{ actingUserId }` → `204`; `409 CONFLICT` while referenced by a non-ended session |
| `POST /internal/v1/servers/:id/test` | `{ actingUserId }` → `{ reachable, error, hostKey: { type, fingerprint, trusted }, probe, revoked? }` ("Fetch & verify", at most 10 per user and minute). Connects to the server's address; an unknown key is recorded as `pending` for that address, so it can then be trusted with `trust-key`. Only with a trusted key and a stored credential does it sign in (the server's user name and credential) and run the capability probe; without a credential it stops after the host key, so no failed login reaches the host. |
| `POST /internal/v1/servers/:id/trust-key` | `{ actingUserId, keyType, fingerprint }` → `204`. Trusts the pending key with that fingerprint; with no pending match, records a pasted pre-trust fingerprint (normalized, §5.9). |
| `POST /internal/v1/servers/:id/replace-key` | `{ actingUserId, keyType, fingerprint, confirmHostname }` → `204`. After a mismatch: revokes the trusted key of that type and trusts the given fingerprint; `confirmHostname` must equal the server's stored hostname (both normalized), else `400` and nothing changes. |
| `POST /internal/v1/servers/:id/revoke-key` | `{ actingUserId, keyType }` → `204`. Marks the trusted key of that type `revoked`. |
| `POST /internal/v1/servers/:id/remote-sessions` | `{ actingUserId }` → `{ error, sessions: [{ socket, origin, sessionId, label, createdAt, lastActivityAt, attachedClients }], cleaned, truncated }` (D-30, §6.12). Connects as the server's user (its credential, its address's trusted key, never prompting), ends the leftovers of sessions the acting user already ended (`cleaned`), and lists the Termdock tmux servers no running session owns: `ended` (a leftover whose kill failed), `unknown`, `other`. Sessions that run in Termdock and other users' sessions are never listed. Why it could not list is in `error` (`CREDENTIAL_REQUIRED` without a stored credential, nothing contacted; `HOST_KEY_REJECTED` for an unknown key, recorded as pending like the server test; `HOST_KEY_MISMATCH`; the connect and sign-in codes), with an empty list. |
| `POST /internal/v1/servers/:id/remote-sessions/terminate` | `{ actingUserId, socket }` → `{ terminated }`. `409` when the socket belongs to a session that runs in Termdock or to another user's session (checked again right before the kill); `terminated: false` when no server answered for it. A failure to connect, sign in or ask the host → `502 { code, message }` with the list's codes. Audited `remote_session.terminated`. |
| `POST /internal/v1/servers/:id/remote-sessions/adopt` | `{ actingUserId, socket, label? }` → `201 { sessionId }`. A new session of the server attached to that tmux server, created as `POST /sessions` creates one (running-session cap → `429`), tmux-protected and counted as ready before. `409` for a running or foreign session's socket and for the leftover of one of the acting user's own ended sessions (Reopen it instead). Audited `remote_session.adopted`. |
| `POST /internal/v1/users/:id/terminate-sessions` | `{ actingUserId }` → `{ terminated }`. Admin only (acting user must be an admin and not banned → else `403`); terminates every non-ended session of the target user (used by the admin "disable user" flow), 4 at a time, answering like `sessions/terminate-all` so it stays inside web's 5 s timeout. |
| `POST /internal/v1/auth-sessions/revoke` | `{ authSessionId? , userId? }` → `204`; closes the matching WebSockets |
| `GET /internal/v1/health` | → `{ ok, sessions, uptimeMs, version }` |

The `servers/:id` routes need a server of the acting user (else `404`; a local server has no address → `400`). The remote-session list and terminate share a limit of 20 calls per user and minute (each opens an SSH connection, like the server test). The server id only names the address and proves ownership: every host-key decision is stored for the user's normalized hostname and port, so it applies to all of that user's servers with that address, never to another user's (§5.9). Their `host_key.*` audit rows target the server of the route (`targetType: 'server'`; at connect time the session's server, or none once it is gone) and carry `{ hostname, port }` in their detail.

### 8.4 i18n

`next-intl` with `en` (default) and `pt-BR`. Messages live in `apps/web/messages/{en,pt-BR}.json`, with keys `area.component.key`. Locale resolution: user preference (DB) → cookie → `Accept-Language` → `en`. No locale prefix in URLs. **CI fails if the two locale files have different key sets.** Server-generated banners written into terminals (§5.7) use the session owner's locale.

---

## 9. Data model (SQLite via Drizzle)

Conventions: `snake_case` tables and columns; UUIDv7 text ids; timestamps as integer epoch milliseconds; JSON as text with zod validation at the boundary; `PRAGMA journal_mode=WAL`, `foreign_keys=ON`. Migrations via `drizzle-kit generate` (never `push` outside local dev), applied by session-manager at boot; web waits for the schema version.

**Writers and lock waits.** SQLite serializes writers globally, and better-sqlite3 blocks the event loop while it waits for a lock. So:

- **session-manager** writes through an **async batched writer**: session events and state updates are queued and flushed in short transactions. Its own writes use `busy_timeout` **250 ms** plus retry, so a long web transaction never stalls the data plane.
- **web** keeps `busy_timeout` **5000 ms**.
- Retention purges (§10.2) run in chunks of 500 rows, each one op of the batched writer, yielding between chunks: never one large delete.

**Auth tables (Better Auth, via the Drizzle adapter):** `user` (+ `username`, `role`, the admin plugin's `banned` / `ban_reason` / `ban_expires` — `banned` is how a user is disabled — `locale`, `totp_required`, `must_change_password`), `auth_session`, `account`, `verification`, `two_factor`. The final names come from Better Auth's schema generator; the session model is renamed to `auth_session`.

**Application tables**

```text
servers               id, user_id→user, name, kind('ssh'|'local'),
                      hostname, port, username,                    -- null only for kind 'local' (CHECK);
                                                                   -- hostname stored normalized
                      credential_id→credentials (nullable, ON DELETE SET NULL; null = prompt in the terminal),
                      protection_mode('auto'|'off'), startup_command,
                      term(default 'xterm-256color'), env_json, keepalive_interval_s(default 15),
                      auto_reopen(default 1), scrollback_lines(default 5000),
                      created_at, updated_at

known_host_keys       id, user_id→user, hostname, port,             -- the address (D-29); no FK to servers
                      key_type, public_key_b64 (null for a pasted pre-trust until first match),
                      fingerprint_sha256 ('SHA256:<43 chars>'),
                      status('trusted'|'pending'|'revoked'),       -- ≤ 1 trusted per user+address+key_type;
                      first_seen_at, decided_by→user, decided_at   -- pending expires 24 h after first_seen_at

credentials           id, user_id→user, name, kind('password'|'private_key'),
                      public_key, fingerprint_sha256,              -- keys only; public data
                      ciphertext, nonce, key_version,              -- AES-256-GCM of the JSON envelope (§10.2)
                      created_at, last_used_at

sessions              id, user_id→user,
                      server_id→servers (nullable, ON DELETE SET NULL; history survives),
                      target_kind('ssh'|'local'),
                      target_hostname, target_port, target_username,   -- local: 'localhost', 0, ''
                      target_credential_id→credentials (nullable, ON DELETE SET NULL),
                      term, scrollback_lines,                      -- copied from the server at creation
                      label, desired_state('running'|'terminated'), state, status,
                      protection_effective('tmux-control'|'tmux-normal'|'none'),
                      tmux_token, tmux_version, remote_identity_json,  -- session_created, pane_pid
                      tmux_socket,                                 -- adopted (D-30): the full socket
                                                                   -- name; null = td-<prefix>-<tmux_token>
                      probe_json, cols, rows,
                      created_at, last_ready_at, ended_at, end_reason

session_events        id, session_id→sessions, type, detail_json, actor_user_id,
                      attachment_id, ip, user_agent, created_at
                                                  -- indexes (session_id, created_at), (created_at)

audit_events          id, actor_user_id, type, target_type, target_id, detail_json,
                      ip, user_agent, created_at  -- indexes (created_at), (actor_user_id)

workspace_layouts     user_id (PK)→user, version, layout_json, updated_at

user_preferences      user_id (PK)→user, theme, terminal_json, updated_at

instance_settings     key (PK), value_json, updated_at            -- e.g. installation_id, vault_key_check,
                                                                  -- require_totp, max_running_sessions_per_user
```

**Live sessions vs edits and deletes.** A session snapshots its target at creation (`target_*`, plus `term` and `scrollback_lines`), so later edits to the server's address, user name or credential affect only new sessions, except for a session that never connected: it follows its server's target until its first `ready` (D-31). Launch settings (`startup_command`, `env_json`) only matter when the remote shell or tmux session is created; policies (`keepalive_interval_s`, `auto_reopen`, `protection_mode` for future reopens) are read live from the server. Deleting a server or credential referenced by a non-ended session is rejected (`409 CONFLICT`, §8.2). `desired_state` transitions are in §5.7.

**Write ownership** (per table). It prevents logical conflicts between the two processes; it does **not** avoid write contention, because SQLite serializes writers globally (see "Writers and lock waits" above).

| Writer | Tables |
|---|---|
| session-manager | `sessions`; `session_events`; all of `credentials` (rows created and deleted via the internal API, `last_used_at`); all of `known_host_keys` (pending, trust, replace, revoke via the internal API); `instance_settings` keys `installation_id` and `vault_key_check`; `audit_events` for host-key, credential, session-rename, remote-session (`remote_session.terminated`, `remote_session.adopted`) and file (`file.*`, when `file_audit_enabled`, §5.12) events; the retention purge, which deletes old `audit_events` and `session_events` rows whoever wrote them (§10.2) |
| web | auth tables; `servers`; `workspace_layouts`; `user_preferences`; every other `instance_settings` key; every other `audit_events` row |

Both processes may read everything. WAL works across the two containers because they share a local Docker volume on the same kernel; network filesystems are not supported (documented). A daemon running on the host with web in a container (direct-mode testing, §13.3) shares the WAL safely only on a Linux host.

Layout JSON (validated by zod in `packages/protocol`):

```ts
type WorkspaceLayout = { version: 1; activeTabId: string | null; tabs: Tab[] };
type Tab = { id: string; title?: string; activePaneId: string; root: PaneNode };
type PaneNode =
  | { type: 'leaf'; id: string; sessionId: string | null }
  | { type: 'split'; id: string; direction: 'row' | 'column'; sizes: number[]; children: PaneNode[] };
```

---

## 10. Security

Termdock is a **privileged bastion**: compromising it can mean compromising every registered server. Security is a first-class component.

### 10.1 Threat model (summary)

| Asset | Threat | Primary controls |
|---|---|---|
| SSH credentials | DB/backup leak; web compromise | Vault encryption with a KEK held only by session-manager; web never sees the KEK; secrets never logged; key credentials recommended for high-value hosts (see the limits below) |
| Live sessions | Keystroke injection or hijack by another user or a forged WS | Ticket auth, Origin check, per-attach ownership checks, revocation |
| Host trust | MITM on first connect | Explicit trust UX with fingerprints, pre-trust, mismatch hard-fail |
| Accounts | Credential stuffing, brute force | Rate limiting, lockout, optional/mandatory TOTP, argon2id/scrypt hashing |
| Instance takeover | Fresh instance exposed before setup | One-time setup token from the logs |
| Browser | XSS → session control | Strict CSP, no `dangerouslySetInnerHTML`, sanitized terminal titles and links |

Honest limits:

- A fully compromised **web** process can mint WS tickets and drive sessions as any user. It cannot read stored secrets, but it can re-point a host to an attacker-controlled sshd and make the daemon authenticate there, which discloses **password** credentials. Private keys are not disclosed, because SSH signatures are bound to the session. Recommendation: use key credentials for high-value hosts.
- **Direct mode** (§10.2): local shells run as the daemon's UID, which can read the master key and the DB, so enabling direct mode gives admins effective access to the vault. It is recommended only outside containers, with a separate unprivileged UID for the spawned shells (documented), and every local session start is audited.
- A compromised **session-manager** is game over by design, like any bastion. The roadmap reduces this (KMS/Vault, worker-per-session).

### 10.2 Controls

- **Vault.** AES-256-GCM, 96-bit random nonce per record. The plaintext is a JSON envelope `{ v: 1, kind, password? | privateKey?, passphrase? }`. AAD = `credential_id ‖ user_id ‖ kind ‖ key_version` (ciphertext cannot be moved between rows, kinds or key versions). `key_version` supports rotation, and a key-check value in `instance_settings` (`vault_key_check`) detects a wrong KEK at boot. KEK = 32 random bytes from `TERMDOCK_MASTER_KEY_FILE` (Docker secret file, mode 0440, group 10001, §13.2). Private keys are validated with ssh2's key parser before storage. Generated keys are ed25519 in OpenSSH format.
- **Master key rotation.** `vault rotate` (`apps/session-manager/src/cli/vault-rotate.ts`, `pnpm --filter @termdock/session-manager vault:rotate --old-key-file … --new-key-file … [--data-dir …] [--dry-run]`) runs while session-manager is stopped. It refuses equal keys and a held data directory lock (§5.8), then holds that lock itself until it is done; verifies the old key against `vault_key_check` (when the new key matches instead, the rotation already happened: exit 3); writes a consistent backup next to the database (`VACUUM INTO pre-rotate-<UTC timestamp>.db`, mode 0600, synced and integrity-checked); then, in **one** `BEGIN IMMEDIATE` transaction, re-encrypts every credential (each must authenticate under the old key at its own key version) and the key check as key version N + 1, verifies them under the new key and commits with `synchronous = FULL`. Any failure rolls everything back; `--dry-run` writes nothing. Output never contains key material. For Compose, `deploy/scripts/rotate-master-key.sh` does the whole sequence: generate `master_key.new`, stop session-manager, run the CLI in a one-off container with both keys mounted read-only, keep the old key as `master_key.old`, install the new one, copy the backup to `deploy/backups/`, start session-manager (which verifies the new key at boot). Procedure and rollback: `docs/guides/install.md` ("Rotating the master key").
- **Operator password reset (D-36).** `reset-password` (`apps/session-manager/src/cli/reset-password.ts`; for Compose, `deploy/scripts/reset-password.sh <username>`, which runs it in the running session-manager container) gives a user a generated temporary password (20 characters of `[a-z2-7]`, printed once on stdout) and, in one transaction, stores its argon2id hash in the user's `credential` account, sets `must_change_password`, deletes the user's `auth_session` rows and writes `auth.password_reset` (no actor, detail `{ via: 'operator', signInsEnded }`); with `--reset-totp`, also `resetTotp` (`packages/db/src/auth-records.ts`, the admin TOTP reset's own code) and `auth.totp_reset`; then it asks the daemon to close the user's WebSockets (`POST /auth-sessions/revoke`, best effort). It refuses a missing database instead of creating one, and an unknown username, listing the existing ones. Procedure: `docs/guides/install.md` ("Resetting a password").
- **Web auth.** Better Auth: public sign-up disabled; users are created by admins with a temporary password and `must_change_password`, which forces a change at first login. Cookies `HttpOnly; Secure; SameSite=Strict`, 7-day sliding expiry (closing the browser does not log out, consistent with G1; the workspace keeps it sliding, §7.1). Login rate limit (a per-IP budget of 10 sign-in attempts per minute, T-15) plus **account lockout per (username, IP) with progressive delay** — implemented by Termdock if Better Auth lacks it (S6). Client IPs come from Better Auth's `advanced.ipAddress` reading Caddy's `X-Forwarded-For` (§4.3). TOTP via the `twoFactor` plugin (trusted-device option); `totp_required` per user and an instance-wide requirement force enrollment at next login; admins can reset a user's TOTP. Disabled users are Better Auth admin-plugin `banned` users. The WS ticket issuer refuses while a TOTP enrollment or a password change is pending, and WS revalidation also checks `banned` (§7.1). Password hashing: argon2id if configurable in Better Auth (Node ≥ 24.7 `crypto.argon2`), otherwise Better Auth's scrypt default; decided in Phase 0.
- **CSRF and Origin.** Server Actions' origin check; route handlers verify `Origin`; WS Origin check.
- **Isolation (structural).** Every web query is scoped by `user_id` through the **user-scoped repository layer** (`apps/web/lib/repo`). A Biome `noRestrictedImports` rule, scoped to `apps/web/**`, forbids importing `@termdock/db` outside that layer and the auth core (`lib/auth`; tests and `next.config.ts` are exempt), so a missing scope in web is a lint error rather than something tests must catch. session-manager's `src/store/` is its own data layer and stays outside the rule: every user-scoped internal API call and every WS attach re-checks ownership there (§8.3). The T0 authorization tests (one case per resource type, WS attach, internal API) back this up.
- **Headers.** Nonce-based CSP (`script-src 'self' 'nonce-…'`; no eval; xterm.js needs none), `style-src 'self' 'unsafe-inline'` (the xterm DOM renderer injects style elements, so `style-src` carries no nonce), `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` (camera, microphone, geolocation, payment, usb off), `Cross-Origin-Opener-Policy: same-origin`, HSTS (Caddy).
- **Terminal escape safety.** OSC 52 clipboard writes are disabled by default (per-user opt-in). Links open only after the UI's confirmation showing the full URL (the user's preference and the in-pane link panel), only for `http(s)`, with `noopener,noreferrer`: plain-text URLs through the web-links addon and OSC 8 hyperlinks through xterm's `linkHandler`, so xterm never opens one on its own; the confirmation shows the parsed `href` that opens (punycode host, percent-encoded invisible characters). Pastes lose their control characters (ESC included) before xterm brackets them, and focus reports are sent only for a real focus change. Titles are sanitized and length-capped, without controls, bidi overrides or zero-width characters (daemon and web strip the same set). No OSC passthrough to the DOM.
- **Host keys (§5.9).** A key the owner revoked fails closed like a mismatch, also when nothing else is trusted: no first-use prompt, no in-flow accept, `trust-key` (pre-trust included) and `hostkey.decision` refuse it, and only `replace-key` (host name confirmed) can trust it again. The prompt carries `revoked: true` and the workspace says so; the event is audited as `host_key.revoked_presented`. A key that is neither trusted nor revoked is first use again (a rotated server). Host keys are verified with SHA-2 signatures only (`ssh-rsa`/SHA-1 is never offered).
- **SSH target policy.** The daemon resolves each host name itself, through the socket's lookup, and connects only to an address that passed the check (no second resolution). Refused by default, for sessions and host tests: loopback, link-local, unspecified, multicast and the daemon's own interface addresses, IPv4-mapped forms included. Private LAN ranges and the Docker host gateway stay allowed; `TERMDOCK_SSH_ALLOW_LOCAL_TARGETS=true` allows everything. A refused session fails with `TARGET_NOT_ALLOWED` and is not retried. Host tests are limited to 10 per user per minute.
- **Launch parameters and remote output.** Server startup commands and environment values are single lines without C0 controls (TAB allowed), checked by the form; a value the remote command builders still refuse (a server or probe value) fails the session with `BAD_LAUNCH_PARAMS` instead of a reconnect loop. A trailing `;` in tmux argv words is escaped as `\;`. tmux control-mode reply blocks are capped (64 MiB for a reply to the daemon's own command, 64 KiB for an unsolicited one; past it the control connection fails and the session reconnects with its backoff), host text quoted in daemon errors and `desync` events is stripped of controls and capped at 300 characters, and the WS revalidation closes a connection after 3 consecutive failed checks. Capability-probe stdout is read up to 64 KiB (then the channel is closed and the probe fails like a timeout), each probe value is cut to 256 characters, and `probe_json` above 16 KiB is dropped.
- **Keyboard-interactive prompts (§5.10).** Host text is capped (name 256, instructions 2048, prompt 256, 16 prompts) and stripped of controls and invisible formatting by the daemon. The panel always shows Termdock's own title and the line "Host user@host asks:", with the host's name and instructions quoted beneath as host content, never as the panel's own words.
- **Resource caps.** Per user: 16 WebSocket connections (the next one closes with 4429) and 64 attached channels across them (more attaches get `RATE_LIMITED`); per connection: 32 channels (one more attach closes the connection with `4400`, a client protocol error) and 64 messages in flight (`4429` beyond). A runtime whose session is not meant to run and has no attachment is evicted after 60 s idle, and a user keeps at most 16 such idle runtimes (the least recently idle go at once beyond that). Compose sets `mem_limit` and `pids_limit` on every container (§13.1).
- **Revocation.** Besides admin ban and password reset, a user's own password change, an admin TOTP reset and sign-out close the affected WebSockets at once through `auth-sessions/revoke` instead of at the next 60 s revalidation (a TOTP reset also revokes the user's auth sessions). The daemon takes the rightmost `X-Forwarded-For` value that is not a trusted proxy.
- **Logging hygiene.** pino `redact` for passwords, keys, tickets, cookies, tokens, `authorization`, server `env`/`policies` and `auth.response` answers; the web logger censors the same keys in structured fields and in JSON embedded in messages. Terminal input/output bytes are never logged. No terminal recording in MVP; when it comes, it is opt-in and encrypted (§18).
- **Audit.** `audit_events`: login success/failure and lockout, TOTP enable/disable/reset, user create/ban/unban, role change, credential create/rename/delete, session rename and removal (D-32), remote tmux leftovers ended or adopted (D-30), host-key pending/trust/replace/revoke/mismatch and revoked key presented, local (direct-mode) session start, admin setting changes, auth-session revocation. `session_events`: created, attached, detached (with IP and user agent), connected, lost, reconnected, restored, degraded, ended. **Retention:** `TERMDOCK_EVENT_RETENTION_DAYS` (default 180; `0` keeps rows forever; otherwise 7 to 3650, anything else fails the boot). session-manager's retention job (`store/retention.ts`) deletes the rows of both tables older than that, whoever wrote them (web's audit events included: retention applies to the table), a few minutes after boot and then every 6 hours, on unref'd timers stopped at shutdown. It deletes the oldest rows first, 500 per batched-writer op, yielding between chunks (§9); both tables have a `created_at` index (`session_events_created_idx`). It logs the per-table counts and the cutoff, never row contents. A session parked in `failed` for longer than the retention loses its specific failure code (its `state_changed` events age out) and shows the generic failure text.
- **Local direct mode.** Off unless `TERMDOCK_ENABLE_LOCAL_SHELL=true` on the daemon **and** enabled in admin settings. Admin-only (the internal API rejects `kind: local` for non-admins). Spawns shells as the daemon's OS user, which can read the master key and the DB, so enabling it gives admins effective access to the vault (§10.1). Recommended only outside containers, with a separate unprivileged UID for spawned shells (documented in the direct-mode guide). Every local session start is audited.
- **Containers.** Both images run as a fixed shared non-root UID/GID (`10001:10001`); read-only root filesystem with `tmpfs: /tmp` (writable data volume; web also gets a tmpfs at `/app/apps/web/.next/cache`); `cap_drop: [ALL]`, `no-new-privileges`, no Docker socket mounted; memory and process limits (`TERMDOCK_DAEMON_MEM_LIMIT` 1g, `TERMDOCK_WEB_MEM_LIMIT` 768m, Caddy 256m; pids 512/256/128) (§13.1).
- **Supply chain.** T-14. pnpm `allowBuilds` blocks every dependency build script (§12): better-sqlite3 loads its bundled prebuilds and ssh2's optional native crypto is skipped. Any native module that would need a build step (e.g. node-pty for P6) is an explicit exception decided when it is added; runtime images carry no compilers. Next.js is kept at or above patched versions (the WS-upgrade SSRF advisory is not reachable because WS never goes through Next: Caddy answers `400` to an upgrade request on any path but `/ws`; patch anyway).

---

## 11. UI/UX specification

### 11.0 Design process (`impeccable`, D-19)

The wireframes in this section define **information architecture and behaviour only**. All visual decisions (visual world, palette, typography, spacing, motion, component styling, terminal color schemes that harmonize with the app chrome) come out of the `impeccable` skill. Termdock's app surfaces use its **Operate** mode (scanability, consistency, real usage scene first; brand in the precise details). A future public landing page would be **Persuade**, and the docs site **Read**.

| When | `impeccable` step | Output |
|---|---|---|
| Phase 0, before any UI code | `init` | `PRODUCT.md`: users (developers/ops), usage scene (long-lived sessions, many hosts, phone on call), tone, constraints |
| Phase 0 | `shape` per core surface: workspace (desktop + mobile), auth (login / 2FA / setup), management (hosts / credentials / profiles), admin, settings | UX briefs reviewed by the owner before implementation |
| Phase 0 (done) | new-work visual world | Direction contract (strip board, D-23) in `apps/web/.impeccable/surfaces/app-workspace.md`. Per the skill, `DESIGN.md` and tokens are written **at the finish of the first UI build** by the documenter, from the built world, not before. |
| As patterns stabilize (P2/P5) | `extract` | Shared tokens and components in `apps/web/components/ui` |
| Before every UI edit | read `craft-floor` (skill rule) | — |
| End of each UI block | one bounded round: desktop + mobile together, then `critique` + `audit` on that block, fix in one batch, confirm once, stop | Findings fixed in the block's commit |
| Before release (P8) | `harden` (errors, i18n, edge cases), `clarify` (en + pt-BR copy), `adapt` (mobile, key bar), `polish` | Release-ready UI |

The skill's own rule applies: verification happens in bounded passes, never as open-ended self-QA loops.

### 11.1 Workspace (desktop)

```text
┌────────────────────┬───────────────────────────────────────────────────────────┐
│ Termdock      ⚙ 👤 │ [ api-prod ● ] [ db ● ] [ staging ◌ ]  +                   │
├────────────────────┼───────────────────────────────┬───────────────────────────┤
│ + New session  ⌘K  │                               │                           │
│                    │  $ kubectl get pods           │  postgres=# \dt           │
│ production-api     │  NAME        READY  STATUS    │  ...                      │
│  ● api-1  🛡 3h42m │  api-7f…     1/1    Running   │                           │
│  ● api-2  🛡 8d11h │  █                            │                           │
│ postgres-prod      │                               │                           │
│  ● db     🛡 2d    │                               │                           │
│ staging            ├───────────────────────────────┴───────────────────────────┤
│  ◌ web  Reconnect… │  ┌ Action required ─────────────────────────────────────┐ │
│                    │  │ Verification code:  [______]   [Submit]              │ │
│ ▸ Ended (12)       │  └──────────────────────────────────────────────────────┘ │
└────────────────────┴───────────────────────────────────────────────────────────┘
```

- **Sidebar**: sessions grouped by state in urgency order (`apps/web/DESIGN.md`, Layout; the wireframe above predates it), each with its status chip (§5.6), a shield for protected sessions (tooltip: "Survives restarts and network drops"; a hollow shield for compatibility mode; none plus a tooltip for unprotected; the warning "remote may kill tmux on disconnect — enable linger" when the §5.11 logind rules give no reliable protection), and uptime. Context menu: rename, open in a new tab, split right/down, terminate (confirmation, with a tip that closing the tab or the browser keeps the session), reopen (only for ended or unprotected sessions, §5.7), and for an ended session "Remove from list…" (confirmation, D-32). "Ended" collapses the last 20, indented under a guide line when open, with "Remove all ended…" at its foot (D-32). The collapsed rail shows a tile's actions button only while the tile has the keyboard focus or its menu is open; the pointer opens the menu with a right-click.
- **New session**: command palette (`Ctrl/Cmd+K`) to search servers, with an optional session name. "Start a session" also follows "Add server".
- **Tabs and splits**: each tab holds a split tree (§9). Panes are resizable. **Closing a pane or tab only detaches.** The session keeps running in the sidebar. Terminating is always explicit.
- **Background tabs**: only the active tab's panes are mounted (attached), so a background tab gets no title or bell updates until it is shown again. Accepted MVP trade-off.
- **Layout persistence**: saved to `/api/layout` (debounced 1 s; `PUT` with `If-Match: <version>`; on `409` the client reloads and re-applies, §8.2). Opening Termdock in any browser restores tabs, splits and the attached sessions, with snapshots (fidelity per §5.3.1). Panes bound to ended sessions show "Session ended — Reopen".
- **Overlays inside the pane**: "Connecting…" / "Restoring…" (a subtle spinner over the last known screen, never a blank terminal); Action required (host key with the fingerprint, keyboard-interactive prompts); Reconnecting (countdown + "Retry now", which skips the backoff wait, and **Stop**, D-31): it stays up through the attempts of a round instead of trading places with the chip, and says "attempt 2 of 4" for a session that never connected, "keeps trying until 14:32" for one that lost its connection; Disconnected (reason + Retry; for a session that never connected also End, without confirmation since nothing runs on the server, and "Edit server"); an info tip at the top of a connected pane while tmux runs inside a protected session (D-33). Retry and Retry now call the retry endpoint, Stop the stop endpoint (§8.3).
- **Keyboard**: when a terminal has focus, every key goes to the terminal. App shortcuts use `Ctrl+Shift+<key>` (configurable): new session, next/previous tab, split, close pane, command palette.
- **Files panel** (D-39, §5.12): a pane can open its session's files beside the terminal, inside the same pane; the toggle sits on that pane (the tab row for a one-pane tab, the caption in a split), and nothing about it is saved in the layout.
- **Terminal features**: fit, WebGL renderer (fallback to DOM), unicode11, search (`Ctrl+Shift+F`), web links (with confirmation), copy-on-select option, right-click paste option, font size zoom, color schemes (bundled presets), bundled JetBrains Mono (OFL) with a system-font option.

### 11.2 Mobile (< 768 px)

- The sidebar becomes a drawer; tabs become a dropdown. The **split structure is shown one pane at a time** (pane switcher), and mobile **never mutates** the split tree, so the desktop layout is preserved.
- **Extra-key bar** above the soft keyboard: `Esc`, `Tab`, `Ctrl` (sticky), `Alt` (sticky), `←↑↓→`, `Home`, `End`, `PgUp`, `PgDn`, `|`, `~`, `/`, `-`, paste, hide keyboard. Ctrl+letter maps to `byte & 0x1f`.
- Touch scrolling of scrollback; pinch or buttons for font size.
- The Files panel (§5.12) takes the whole screen, from a button in the pane's header, with the way back to the terminal.
- Typing on the phone makes it the active attachment, so the session resizes to the phone (D-11). The desktop then shows it letterboxed until it is used again. A per-attachment "lock size" toggle is on the roadmap.

### 11.3 Accessibility and polish

Dark only (D-26); xterm.js screen-reader mode toggle; visible focus; all non-terminal pages keyboard-navigable; reduced-motion respected.

---

## 12. Repository layout and conventions

```text
termdock/
├── apps/
│   ├── web/                       Next.js 16 — UI + control plane
│   │   ├── app/                   routes (§8.1), API route handlers
│   │   ├── components/            ui/, workspace/, servers/, credentials/, admin/, auth/, settings/, manage/, icons/
│   │   ├── lib/                   auth/ (Better Auth core), repo/ (user-scoped db access), actions/ (Server Actions),
│   │   │                          terminal/ (ws client, channels), sessions/, workspace/, internal-api client, logger, CSP
│   │   ├── messages/              en.json, pt-BR.json
│   │   └── test/                  T0 tests
│   └── session-manager/
│       ├── src/
│       │   ├── main.ts            boot, restore, signals (run directly: `node src/main.ts`)
│       │   ├── config/            env parsing (zod), logger (pino)
│       │   ├── core/              types.ts (canonical interfaces), SessionRuntime (SessionHost), registry, state machine,
│       │   │                      protection, backoff, transport and driver factories
│       │   ├── store/             SQLite stores (sessions, host keys, settings, audit, ownership checks), batched writer,
│       │   │                      event retention, data directory lock
│       │   ├── transport/         ssh/ (ssh2, host-key check, keyboard-interactive, target policy);
│       │   │                      local/ (child_process + node-pty) planned for Phase 6
│       │   ├── drivers/           raw-pty/, tmux-control/ (parser, correlator, commands, input, rebuild, boundary);
│       │   │                      tmux-normal/ planned for Phase 7
│       │   ├── probe/             capability probe, tmux version parsing
│       │   ├── emulator/          headless wrapper, serialize view
│       │   ├── attachments/       size policy, coalescing, backpressure, wire encoding
│       │   ├── ws/                server, protocol handlers, client IP
│       │   ├── internal-api/      server, server test, remote sessions (D-30)
│       │   ├── vault/             master key, vault, CredentialProvider, rotation
│       │   └── cli/               vault-rotate.ts (§10.2)
│       └── test/                  per area: T0 (*.test.ts) and T1 (*.int.test.ts, against test/sshd)
├── packages/
│   ├── protocol/                  WS v1 + internal API + layout schemas (zod), binary codec, tickets, toSessionStatus
│   ├── db/                        Drizzle schema, migrations, client factory, pragmas, file lock
│   ├── terminal-config/           pinned xterm options, unicode provider, query silencer, mode tracker, UTF-8 aligner
│   └── shared/                    ids (UUIDv7), errors/codes (each app has its own logger)
├── scripts/                       test-area.ts (T1 runner), test-release.ts + release-smoke.ts (§15.4), cdp.ts,
│                                  ui-capture.ts (screenshot sessions); dev-session.ts (dev-only CLI, P1; never shipped in images)
├── deploy/
│   ├── compose.yaml, .env.example
│   ├── Caddyfile
│   ├── docker/                    web.Dockerfile, session-manager.Dockerfile
│   └── scripts/                   init-secrets.sh, backup.sh, restore.sh, rotate-master-key.sh,
│                                  reset-password.sh
├── test/
│   └── sshd/                      Dockerfiles (D-22): alpine:3 no-tmux, ubuntu:22.04 3.2a, ubuntu:24.04 3.4, alpine:edge newest
└── docs/
    ├── implementation-plan.md     (this file)
    ├── architecture.md, security.md
    ├── adr/                       ADR-0001… (spike outcomes and design decisions)
    └── guides/                    install.md, configuration.md; direct-mode.md and docker-host.md planned for Phase 6
```

**Conventions**

- **Language: English** for code, identifiers, comments, docs, commit messages and UI default copy (D-18).
- TypeScript **6.0.3** (pinned: TS 7 rewrote the compiler and its Next.js/tooling compatibility is unverified), `strict`, ESM only.
- Lint and format with **Biome** (a single dependency; `biome.json` at the root). The isolation rule (`noRestrictedImports` for direct `@termdock/db` imports in `apps/web/**`, §10.2) lives there.
- session-manager runs TypeScript directly with Node 24 type stripping (`node src/main.ts`), so its code uses erasable syntax only. There is no build step and no tsx.
- pnpm **11.14.0** (the `packageManager` field) with workspaces and `workspace:*` internal deps; exact external versions; `engines` set; `.nvmrc` = 24. pnpm `allowBuilds` blocks every dependency build script: better-sqlite3 loads its bundled prebuilds, and ssh2's optional native crypto is skipped.
- Root scripts: `pnpm check` (typecheck + lint + T0), `pnpm test:area <terminal|ssh|tmux>` (T1), `pnpm format`.
- Commits (D-20): one or more commits per delivered functional block, made by the orchestrator after verification. Messages are short and imperative, at most 2 lines, with no co-author or attribution trailers. Each verified commit is pushed to `origin main`.
- Every architectural change or spike outcome gets an ADR in `docs/adr/`.

---

## 13. Deployment and operations

### 13.1 Docker Compose

[`deploy/compose.yaml`](../deploy/compose.yaml) is the deployment and its own reference; [`docs/guides/configuration.md`](guides/configuration.md) documents every variable, port, network and volume, and [`docs/guides/install.md`](guides/install.md) the procedure. Its shape:

- **caddy** (official image, pinned by digest): the only service with published ports, `${TERMDOCK_HTTP_PORT:-80}` and `${TERMDOCK_HTTPS_PORT:-443}` (TCP, plus UDP for HTTP/3), the same port inside and outside; on `edge` only, never on `internal`; volumes `caddy-data` and `caddy-config`.
- **web** (`deploy/docker/web.Dockerfile`): on `edge` and `internal`; `TERMDOCK_INTERNAL_URL=http://session-manager-internal:3002`; secrets `auth_secret`, `internal_token`, `ws_secret`; volume `termdock-data:/data`; tmpfs at `/tmp` and `/app/apps/web/.next/cache`.
- **session-manager** (`deploy/docker/session-manager.Dockerfile`): on `edge`, and on `internal` with the alias `session-manager-internal`, which its internal API binds to (`TERMDOCK_INTERNAL_HOST`), so `:3002` never listens on `edge`; secrets `master_key`, `internal_token`, `ws_secret`; volume `termdock-data:/data`; `extra_hosts: host.docker.internal:host-gateway` (§13.4); `stop_grace_period: 30s` (the daemon's own budget is 25 s, §5.8); `TERMDOCK_ENABLE_LOCAL_SHELL` fixed to `false`.
- Every service: `read_only`, tmpfs `/tmp`, `cap_drop: [ALL]` (Caddy adds back `NET_BIND_SERVICE`), `no-new-privileges`, `restart: unless-stopped`, `mem_limit` and `pids_limit` (§10.2). Both apps run as `10001:10001` and have healthchecks; caddy starts after both are healthy, web after session-manager (which migrates the database).
- Networks: `edge` with the fixed subnet `172.30.10.0/24` (session-manager trusts `X-Forwarded-For` from it, §4.3) and `internal` (`internal: true`: no gateway).

`Caddyfile`: `{$TERMDOCK_DOMAIN}` with `reverse_proxy /ws session-manager:3001` and `reverse_proxy web:3000`; `TERMDOCK_TLS=off` serves the same routes over plain HTTP for a reverse proxy in front, trusting `X-Forwarded-For` only from `TERMDOCK_REVERSE_PROXY` (D-35); `TERMDOCK_TLS=auto` (Caddy's automatic HTTPS: ACME for a public domain, the local CA with Caddy's 12-hour certificates for `localhost` and IP addresses) or `internal` (always the local CA, with 30-day certificates and a 90-day intermediate, D-34; the env template's choice for the localhost trial). Caddy sets `X-Forwarded-For` and is the only trusted proxy (§4.3).

Compose `secrets:` with `file:` are bind mounts outside swarm (the `uid`/`gid`/`mode` keys are honored only in swarm), so the containers see the files' own ownership and mode; `init-secrets.sh` sets them (§13.2).

### 13.2 Configuration (environment)

[`docs/guides/configuration.md`](guides/configuration.md) is the reference: defaults, validation, compose values and meaning of every variable. Secrets are always files (`…_FILE`, the trimmed content is the secret); there is no `TERMDOCK_WS_SECRET`, `TERMDOCK_INTERNAL_TOKEN` or `BETTER_AUTH_SECRET` variable. The variables, by reader:

- **Compose settings** (`deploy/.env` or the shell; everything else is fixed in `deploy/compose.yaml`): `TERMDOCK_DOMAIN`, `TERMDOCK_HTTP_PORT`, `TERMDOCK_HTTPS_PORT`, `TERMDOCK_BIND_ADDRESS`, `TERMDOCK_PUBLIC_URL`, `TERMDOCK_TLS`, `TERMDOCK_REVERSE_PROXY`, `TERMDOCK_LOG_LEVEL`, `TERMDOCK_DAEMON_MEM_LIMIT` / `TERMDOCK_WEB_MEM_LIMIT` (container memory limits, default `1g` / `768m`), `TERMDOCK_SSH_ALLOW_LOCAL_TARGETS`, `TERMDOCK_EVENT_RETENTION_DAYS`.
- **session-manager**: `TERMDOCK_PUBLIC_URL`, `TERMDOCK_DATA_DIR`, `TERMDOCK_WS_HOST`, `TERMDOCK_WS_PORT`, `TERMDOCK_WS_SECRET_FILE`, `TERMDOCK_INTERNAL_HOST`, `TERMDOCK_INTERNAL_PORT`, `TERMDOCK_INTERNAL_TOKEN_FILE`, `TERMDOCK_MASTER_KEY_FILE`, `TERMDOCK_TRUSTED_PROXIES` (§4.3), `TERMDOCK_ENABLE_LOCAL_SHELL` (§10.2), `TERMDOCK_SSH_ALLOW_LOCAL_TARGETS` (§10.2), `TERMDOCK_EVENT_RETENTION_DAYS` (§10.2) and `TERMDOCK_LOG_LEVEL`, which only the daemon reads (web has no log level setting).
- **web**: `TERMDOCK_PUBLIC_URL`, `TERMDOCK_DATA_DIR`, `BETTER_AUTH_SECRET_FILE`, `TERMDOCK_WS_SECRET_FILE`, `TERMDOCK_INTERNAL_URL` (`http://session-manager-internal:3002` in compose), `TERMDOCK_INTERNAL_TOKEN_FILE`; at build time only, `NEXT_PUBLIC_TERMDOCK_WS_URL` (a development override of the same-origin `/ws`).
- **caddy**: `TERMDOCK_DOMAIN`, `TERMDOCK_HTTP_PORT`, `TERMDOCK_HTTPS_PORT`, `TERMDOCK_TLS`, `TERMDOCK_REVERSE_PROXY`.

`deploy/scripts/init-secrets.sh` generates every secret with `openssl rand` into `./secrets/` (gitignored), sets mode 0440 and group 10001 (the images' shared GID) on each file, and warns: **back up `master_key`. Losing it means losing every stored credential.**

### 13.3 Running outside the container (direct-mode testing, D-15b)

`docs/guides/direct-mode.md` (planned with Phase 6) documents running `session-manager` manually on a host:

1. Prerequisites: Node 24, pnpm, and build tools in case node-pty has no prebuild for the platform.
2. `pnpm install`. There is no build step: session-manager runs with `node src/main.ts` (Node 24 type stripping).
3. Env file pointing at a local data dir and secrets; `TERMDOCK_ENABLE_LOCAL_SHELL=true`. Recommended: spawned shells run under a separate unprivileged UID (§10.1).
4. Run `web` either via compose (with the data dir bind-mounted and the internal URL pointing at the host; sharing the SQLite WAL this way is safe only on a Linux host, §9) or with `pnpm --filter web dev`.
5. Enable direct mode in admin settings; create a host of kind `local`.

Local sessions use `LocalTransport`: node-pty for raw mode, and `child_process.spawn('tmux', ['-u','-L',…,'-C',…])` for `tmux-control` when local tmux ≥ 3.2 is present. The same drivers run over a different transport, so protected local sessions can survive daemon restarts too — **but only when the tmux server lives outside the daemon's cgroup**: not inside the container, and under systemd either `KillMode=process` on the daemon's unit or tmux launched via `systemd-run --user --scope`.

### 13.4 "This Docker host" preset (D-15a)

"Add this Docker host" (`/servers/docker`, linked from the servers list and the Add server page) generates an ed25519 credential, creates a server `<user>@host.docker.internal:22` that uses it, and shows the exact `authorized_keys` line, plus a copy-paste command, for that user. The first connect goes through the normal host-key trust flow.

### 13.5 Operations

- Health: `GET /api/health` (web) and `GET /internal/v1/health` (daemon); compose healthchecks.
- Backups: `deploy/scripts/backup.sh` runs SQLite `VACUUM INTO` to a timestamped file (safe online). Restore script plus doc. The master key is backed up separately.
- Logs: JSON (pino) to stdout.
- Upgrades: pull, then `docker compose up -d`. web restarts freely; a session-manager restart preserves protected sessions (§5.8). The release notes say so.

---

## 14. Phased delivery plan

Dependency graph and parallel tracks:

```text
Phase 0 (foundations + spikes + canonical contracts)
   ├──► Track A: P1 data plane core + vault + internal API ──► P3 tmux control ──► P4 resilience + host-key routes
   ├──► Track B: P2 control plane web app & auth (consumes the internal API)
   └──► Track C: P5 workspace UI (against protocol v1 + a mock WS server)

   P2 + P4 + P5 ──► integration step (host-key and keyboard-interactive UI checks)
   P2 + P4      ──► P6 local modes   (P2: admin setting + UI · P4: daemon side)
   P4           ──► P7 tmux normal fallback
   all phases   ──► P8 hardening & release v0.1.0
```

Each phase lists exit criteria that are **verifiable by a command or a check**. A phase is done only when the orchestrator has re-run them independently (§16), and each delivered block ends with a commit (D-20).

Exit criteria are delivery verifications, **not** a mandate to build permanent test suites (D-21). Each criterion is tagged with where it lives afterwards (tiers defined in §15):

| Tag | Meaning |
|---|---|
| `[T0]` | Becomes a permanent test in the **always** set (fast, every change) |
| `[T1]` | Becomes a permanent test run **when that area changes** |
| `[T2]` | Belongs to the **pre-release** battery (routine in §15.4, D-25) |
| `[once]` | Verified once at delivery (scripted or manual); the result goes in the delivery report and commit description. No permanent test. |

### Phase 0 — Foundations, spikes, canonical contracts

**Scope**

- Monorepo scaffold (pnpm 11.14.0, TypeScript 6.0.3, Biome, Vitest), CI (GitHub Actions: typecheck, lint, unit, i18n parity, build; integration job with the sshd matrix).
- Every dependency inspected via `ats-dependency-security` before install. Exact pins.
- `test/sshd` images (D-22), all built in Phase 0 because S2 needs them:
  - **Core** (used by T1): alpine:3 (no tmux), ubuntu:22.04 (tmux **3.2a**, the floor), alpine:edge (the **newest packaged** tmux).
  - **Matrix** (used by S2 and T2): the core images plus ubuntu:24.04 (tmux **3.4**). The matrix covers exactly these three tmux versions.
  - **Keyboard-interactive/OTP**: a PAM variant built on one of the approved base images; the only image that may slip to P4.
  - No image with tmux < 3.2 is approved; see Phase 7.
- **Fixture recording**: during S2, record real tmux control-mode transcripts (one per approved tmux version) into `test/fixtures/tmux/`, so parser tests replay them in milliseconds instead of needing containers.
- **UI design foundation** (§11.0, parallel with the spikes): `impeccable init` → `PRODUCT.md`; `shape` briefs for the core surfaces; visual world → `DESIGN.md` + tokens.
- **Spikes** (each ends in an ADR with a go/no-go):
  - **S1 — Emulator fidelity & snapshot barrier.** headless + serialize vs the browser xterm: golden scenarios (bash prompt, `vim` with alt screen, `htop`, `less`, long wrapped lines, CJK/emoji, 256/truecolor, resize). Verify that write-callback barrier consistency holds; enumerate what the serialize addon does not restore and validate the mode tracker and epilogue against it (§5.3.1); establish the query-silencer coverage list; measure `snapshot()` cost with 10k lines of scrollback and size the snapshot cache (§5.4).
  - **S2 — tmux control protocol core.** Exec without PTY plus `-u -C`; remote command wrapping (`exec sh -c`) and quoting; byte framing; FIFO correlation incl. `flags=0` blocks; octal and `%extended-output` decoding; `send-keys -H` batching; `refresh-client -C`; across the three approved tmux versions (D-22).
  - **S3 — Snapshot boundary under load** (§6.8). `yes` / `seq 1 10000000` while capturing; the live emulator vs the one rebuilt from capture must match.
  - **S4 — Flow control.** `pause-after`, `%pause` → continue + snapshot; `cat` of hundreds of MiB; daemon memory bound; exec-channel pause/resume interplay with `pause-after` (§5.5); cost of `%pause`-triggered rebuilds and of `snapshot()` under load.
  - **S5 — Lifecycle.** `kill -9` daemon mid-stream; SSH drop; stale-client detach; `detach-on-destroy`; socket loss (SIGUSR1); `KillUserProcesses` (read via `busctl`) × linger × `systemd-run --scope` (the §5.11 logind rules); `%exit` after an external `detach-client` (must reattach, not end, §6.10); `env -u TMUX`; remote reboot detection.
  - **S6 — Better Auth fit.** username + twoFactor + admin plugins with the Drizzle SQLite adapter; disabling sign-up; admin user creation; argon2 configurability. Go/no-go on each of: account lockout per (username, IP) with progressive delay (implemented by Termdock if Better Auth lacks it); temporary password with forced change on first login (`must_change_password`); forced TOTP enrollment (`totp_required`); admin TOTP reset; `banned` for disabled users.
- **Canonical contracts, written by the orchestrator:** `packages/protocol` (WS v1 types + binary codec + tests, internal API schemas, layout schema, `toSessionStatus`), `packages/db` schema v1, `core/types.ts` interfaces (`Transport`, `Driver`, `DriverContext`, `Emulator`, `SessionHost`, `AttachmentHandle`, `CredentialProvider`, §5.1), `packages/terminal-config` (incl. the query silencer and the mode tracker), error-code catalog, i18n key conventions.

**Exit criteria**

- **A.** `[T0]` `pnpm check` (typecheck + lint + T0 tests) green on a clean clone.
- **B.** `[once]` The D-22 sshd images start (the KI/OTP variant may follow in P4); a smoke script SSHes into each one with a seeded key and prints `tmux -V` (or "absent").
- **C.** `[once]` ADR-0001…0006 recorded with the measured results of S1–S6 and a go/no-go. A **small** set of S1/S3 golden scenarios (vim alt screen, wrapped lines, colors, CJK/emoji) is kept as `[T1]`; the rest of the spike code is throwaway.
- **D.** `[T0]` The protocol codec has round-trip tests for every frame and message type. `[T0]` Version pin: `@xterm/xterm` and `@xterm/headless` resolve to the same version. `[T0]` Query-silencer coverage: with the silencer there is no reply for every query form; without it there is exactly one. `[once]` `packages/db` generates migration `0000` cleanly.
- **E.** `[once]` `apps/web/PRODUCT.md` exists; the owner approved the workspace and auth `shape` briefs and chose the visual direction (D-23, direction contract recorded). `DESIGN.md` follows at the finish of the first UI build (§11.0).

### Phase 1 — Data plane core (unprotected path), vault, internal API

**Scope**: `SshTransport` (ssh2: keepalive 15 s × 3, password/key auth through `CredentialProvider`, host-key verification against seeded keys), `RawPtyDriver`, emulator wrapper (mode tracker, `snapshot()`), `SessionRuntime` (`SessionHost`) and registry, state machine, WS server with protocol v1 and **real ticket validation** (`verifyTicket` + nonce cache from `packages/protocol`, Origin check, auth-session and `banned` revalidation; in P1 tickets are minted by the dev CLI with the shared secret), attachments with size policy, resize-by-snapshot, the snapshot cache, coalescing and backpressure, the batched DB writer. **Vault** (envelope encryption, the vault-backed `CredentialProvider`) and the **internal API** with bearer auth: credentials create/delete; sessions create/terminate/retry/reopen/list (the host-key routes come in P4). **Dev CLI** `scripts/dev-session.ts`: seeds a user, host, profile and credential directly in the DB and creates and attaches sessions (dev only; never shipped in images). A minimal dev page for attaching.

**Exit criteria**

- **A.** `[T0]` Unit tests for the intricate pure logic only: state machine and `toSessionStatus`, seq/snapshot-barrier bookkeeping, size policy.
- **B.** `[T1]` Integration (no-tmux sshd): open a session, run `vim /etc/hosts`, close the WS, reattach → the attached client's SerializeAddon `serialize()` output equals the server emulator's (text + attributes + cursor + alt-screen flag), **and** a mode/state probe matches (mouse encoding, cursor style, alt screen).
- **C.** `[once]` `[T2]` Two attachments: input from either reaches the shell; activating one resizes the session; every attachment receives a sequenced `terminal.resized` and its buffer still equals the server's afterwards.
- **D.** `[once]` `[T2]` A slow-reader client (reads paused for 10 s during `seq 1 2000000`) → daemon RSS stays under a fixed bound; the client receives a resync snapshot once it reads again and ends in the correct state.
- **E.** `[once]` `[T2]` `cat` of a 200 MiB file → no crash, emulator consistent, RSS bounded.
- **F.** `[T0]` Vault unit tests (round trip of the JSON envelope, AAD binding incl. `kind` and `key_version`, wrong-key detection). `[once]` A grep of the DB dump finds no seeded secret material.
- **G.** `[T0]` Internal API: a missing or wrong bearer → `401` (constant-time compare). Daemon-side isolation: user B's WS `session.attach` with A's session id → FORBIDDEN, and internal-API calls with B as `actingUserId` on A's session or credential → rejected.
- **H.** `[once]` `scripts/dev-session.ts` seeds a user, host, profile and credential, then creates and attaches a session against the no-tmux sshd.

### Phase 2 — Control plane web app & auth

**Scope**: Next.js app shell; Better Auth (username/password, TOTP, admin plugin: temporary password with forced change, `banned`, TOTP reset; lockout per (username, IP)); `/setup` token flow; admin users; hosts/credentials/profiles CRUD, consuming the internal API for credentials and host-key actions (developed against the internal-API schemas fixed in Phase 0); the user-scoped repository layer and the Biome `noRestrictedImports` rule (§10.2); layout API with `If-Match`; WS ticket issuer (`POST`, `no-store`, refused while a password change or TOTP enrollment is pending; validation already lives in the daemon since P1); revocation; `/activity`; `/admin/audit`; i18n `en` + `pt-BR`; CSP and security headers; Better Auth `advanced.ipAddress` from Caddy's `X-Forwarded-For`.

**Exit criteria**

- **A.** `[once]` `[T2]` With no users, `/setup` requires the token from the logs; after setup, `/setup` returns 404.
- **B.** `[once]` `[T2]` Login; TOTP enroll and verify; an admin-enforced TOTP forces enrollment on next login; a temporary password forces a change at first login; lockout per (username, IP) with progressive delay after N failed attempts.
- **C.** `[T0]` Isolation (web side): user B cannot read or mutate user A's hosts, credentials, profiles or sessions. Tested at the **repository/authorization layer** (one case per resource type), not through the browser. The daemon side is P1 G.
- **D.** `[once]` The web process and image have no access to the master key; credential secrets submitted in forms go straight to the internal API and are never written by web.
- **E.** `[T0]` WS ticket and Origin unit tests: expired → reject, replayed → reject, bad Origin → reject, revoked auth session → close; the issuer refuses while a password change or TOTP enrollment is pending; revalidation closes a `banned` user's connections.
- **F.** `[T0]` i18n key parity. `[once]` UI switches en ↔ pt-BR and persists the choice.
- **G.** `[once]` `impeccable` critique + audit round on the auth, management and admin surfaces; findings fixed.

### Phase 3 — tmux control-mode protection

**Scope**: probe and mode selection (`exec sh -c` wrapping, `tmux_path`, `utf8_locale`, logind rules), `TmuxControlDriver` (parser, correlator, input encoder, resize via `ctx.resized()`, flow control incl. exec-channel pause/resume, snapshot rebuild through `ctx.replaceState()` with the nonce terminator, desync recovery, `%exit` confirmation via `has-session`), boot restore for protected sessions, launch via `systemd-run --scope` when the logind rules call for it and the linger warning otherwise, identity tracking for remote reboots, terminate via `kill-server`.

**Exit criteria** (the `[once]` checks run at delivery across the three approved tmux versions — 3.2a, 3.4 and the newest packaged, D-22; `[T1]` runs on the core images only)

- **A0.** `[T0]` Control-protocol parser tests replaying the recorded fixtures: framing, octal unescape, `%extended-output`, FIFO correlation (incl. `flags=0` blocks), guard-line spoofing.
- **A.** `[T1]` (3.2a + newest packaged) `[T2]` (all three versions) Open a protected session, run `seq 1 5000` then `vim`; restart session-manager → after restart, the attachment shows the same vim screen, and after quitting vim the scrollback contains the `seq` output.
- **B.** `[once]` `[T2]` Network drop for 30 s, then reconnect → status goes Reconnecting… → Connected; the screen is identical; no tmux UI ever visible (no status line; `Ctrl-B` sent into `cat -v` shows `^B`).
- **C.** `[once]` `[T2]` `yes` for 60 s → no `%exit`; RSS bounded; the screen is consistent after `Ctrl-C`.
- **D.** `[once]` Running `tmux` inside the session starts the user's own tmux without the nesting warning.
- **E.** `[T1]` `exit` in the shell → session `ended` once `has-session` confirms; `tmux -L <socket> ls` on the remote reports no server.
- **F.** `[once]` No tmux (alpine:3) → `none` with notice. The "tmux too old" notice has no container target until an image with tmux < 3.2 is approved (Phase 7).

### Phase 4 — Resilience and interactive flows

**Scope**: reconnect policy with backoff and Retry; the **host-key routes** in session-manager (`trust-key`, `replace-key`, `revoke-key`; pending rows with a 24 h expiry) and the protocol flow (store pending + abort + `hostkey.prompt`, `hostkey.decision` by fingerprint, reconnect); pre-trust and fetch & verify on the daemon side; keyboard-interactive relay (`promptId`, 100 s prompt timeout, `readyTimeout` 110 s); graceful shutdown; unprotected `auto_reopen` with banner; `server.shutting_down` notification. Exit criteria are stated at protocol level (WS messages and internal API); the UI checks happen in the integration step below.

**Exit criteria**

- **A.** `[T0]` Host-key decision logic (trusted / unknown / mismatch → continue / store pending + abort + prompt / hard-fail) and fingerprint normalization. `[once]` Protocol level, against a test sshd: an unknown key → a `pending` row, the connection aborted, `hostkey.prompt` with the key type and the `SHA256:` fingerprint; `hostkey.decision { fingerprint, accept: true }` trusts exactly that key (audit event) and the session reconnects to `ready`; a decision for any other fingerprint trusts nothing; a later key change → `failed` `HOST_KEY_MISMATCH` with no in-flow accept; `replace-key` and `revoke-key` behave as specified in §8.3.
- **B.** `[once]` `[T2]` KI/OTP sshd, over the WS protocol: `auth.prompt` (with `promptId`) reaches every connection of the user; a correct `auth.response` connects; a stale `promptId` is discarded; letting the prompt expire (100 s) closes the connection and leaves the session in `awaiting_user_input`, and the next connect attempt prompts again; during a reconnect the session waits in `awaiting_user_input`.
- **C.** `[T0]` Backoff schedule (fake timers).
- **D.** `[once]` Unprotected session + daemon restart → new shell with the banner when `auto_reopen`, `ended(service_restarted)` otherwise.
- **E.** `[once]` `[T2]` Stopping session-manager → within the grace period, remote `list-clients` shows no Termdock control clients, and the tmux sessions are still alive.

### Phase 5 — Workspace UI

**Scope**: sidebar, command palette, tabs, split panes, layout persistence (`If-Match`, reload and re-apply on `409`), overlays (incl. Retry / "Retry now" through the retry endpoint and `server.shutting_down` handling), status chips and shields (incl. the linger warning), multi-attach rendering (scale/letterbox), the client snapshot rules (queue `OUTPUT` while a `SNAPSHOT` is applied, `terminal.resync`), the periodic get-session call (§7.1), terminal settings, mobile layout and the extra-key bar, themes, a11y pass. Built against protocol v1 with a mock WS server first, then integrated.

**Exit criteria**

- **A.** `[T2]` (Playwright, the product's signature flow) Build 2 tabs with 3 panes, close the browser context, open a new context → identical layout and identical pane contents, and again after a session-manager restart.
- **B.** `[once]` Mobile emulation: the key bar sends Esc, `Ctrl+C` and arrows; bytes checked at a test shell (`cat -v`). `[T2]` Manual check on a real phone.
- **C.** `[once]` Two browsers on one session: the passive one renders at the server size (scaled); typing in it takes over and resizes.
- **D.** `[once]` Closing a pane leaves the session running (still in the sidebar); terminate requires confirmation.
- **E.** `[T0]` i18n key parity. `[once]` An inventory pass finds no hard-coded user-facing strings.
- **F.** `[once]` `impeccable` bounded round (desktop + mobile) followed by critique + audit on the workspace; findings fixed.

### Integration step — P2 + P4 + P5

Run by the orchestrator once P2, P4 and P5 are delivered (§16.3).

- **A.** `[once]` Host-key UI end to end: "Action required" shows the `SHA256:` fingerprint; accepting persists it (audit event) and the session connects; a later key change shows the red mismatch alert with no in-flow accept; "Replace trusted key" requires typing the host name.
- **B.** `[once]` Keyboard-interactive UI on the KI/OTP sshd: the prompt renders in the browser (`echo: false` as a password input); a correct code connects; after an expired prompt, the next connect attempt shows the prompt again.

### Phase 6 — Local modes

**Scope** (depends on P2 for the admin setting and UI, and on P4): Docker-host preset (key generation, `authorized_keys` helper), `LocalTransport` (node-pty raw; local `tmux -C`), daemon flag + admin setting gating (admin-only), an audit event for every local session start, `docs/guides/direct-mode.md` (incl. the separate-UID recommendation and the cgroup caveat, §13.3) and `docs/guides/docker-host.md`.

**Exit criteria**

- **A.** `[once]` The preset creates the host and credential and shows a valid `authorized_keys` line; with it installed on the test host, a session connects through `host.docker.internal`.
- **B.** `[T0]` The internal API rejects `kind: local` with the flag off, and for non-admin users with the flag on (authorization-layer tests). `[once]` The UI hides the option.
- **C.** `[once]` Daemon run outside the container with the flag on: a local session opens a shell as the daemon user and its start is audited; with local tmux ≥ 3.2 it is protected and survives a daemon restart, provided the tmux server is outside the daemon's cgroup (§13.3).
- **D.** `[once]` The direct-mode guide is followed verbatim on a clean VM and works.

### Phase 7 — tmux normal-mode fallback

**Scope**: `TmuxNormalDriver` with the §6.11 configuration; best-effort history restore; "compatibility mode" badge.

**Test target.** D-22 approves no image with tmux < 3.2. The P7 test target requires a separate owner approval of such an image when P7 starts; until then the fallback is untested.

**Exit criteria**

- **A.** `[once]` `[T2]` On the owner-approved image with tmux < 3.2: the session is protected, no status line is visible, `Ctrl-B` reaches the app, and a daemon restart restores the visible screen.
- **B.** `[once]` The badge and tooltip indicate compatibility mode; the limitations are documented.

### Phase 8 — Hardening and release v0.1.0

**Scope**: security review, fixes, `vault rotate` CLI, compose finalization (digests pinned; deployment base images approved by the owner, D-22), backup/restore scripts, soak test, docs (README, install, configuration, security model, architecture overview, ADR index), LICENSE, CHANGELOG.

**Exit criteria**

- **A.** `[once]` `[T2]` Security review report (scope: auth, vault, WS, internal API, isolation, escape-sequence handling, container hardening) with every High/Critical finding fixed and re-verified.
- **B.** `[T2]` From a clean checkout: `deploy/scripts/init-secrets.sh && docker compose -f deploy/compose.yaml up -d` → working instance at `https://localhost` (Caddy internal CA); a scripted smoke test passes.
- **C.** `[T2]` Backup → wipe → restore reproduces users, hosts and sessions metadata; protected sessions resume.
- **D.** `[T2]` 24 h soak: 20 sessions with periodic output and random attach/detach → no crash; RSS growth within budget; no FD leaks.
- **E.** `[T2]` Vulnerability scan (OSV via `ats-dependency-security` batch mode) shows no known High/Critical vulnerabilities. Now the `osv` step of `pnpm test:release` (§15.4), which is stricter: any advisory not in the allowlist fails. Passed 2026-10-16 (one moderate, dev-only advisory allowlisted).
- **F.** `[once]` `impeccable` release passes (`harden`, `clarify`, `adapt`, `polish`) done; docs reviewed.
- **G.** `[once]` The owner has defined the pre-release routine (§15.4) and it has been run once end to end. **Done 2026-10-16:** the first full `pnpm test:release` run passed every step (guard, T0, all 11 T1 files, OSV, image builds, smoke) in 372 s on the 3.8 GB / 2-CPU development machine.
- **H.** `[T2]` CSP check: no CSP violations are reported during the E2E signature flow (P5 A). Now checked by the smoke of `pnpm test:release` (§15.4) across its whole flow. Passed 2026-10-16, after zod's eval probe was turned off (`apps/web/instrumentation-client.ts`).

---

## 15. Testing strategy (lean, risk-based — D-21)

### 15.1 Principles

- **Test what breaks the core promise or security; skip the rest.** The core promise is "the terminal is as I left it" (fidelity per §5.3.1). Security means isolation, secrets and authentication.
- Unit-test only **pure, intricate logic** (parsers, codecs, state machines, crypto, authorization decisions). Prefer **a few high-value integration tests** over many shallow ones.
- Spikes are experiments: their code is thrown away, except a small set of golden scenarios and the recorded tmux fixtures.
- **Time budgets**: T0 under ~2 min locally · T1 under ~10 min per area · T2 may take hours and runs only before a release.
- Test fixtures never disable host-key checking: images ship known host keys that tests pre-trust.

### 15.2 Tiers

| Tier | When it runs | Command | Contents |
|---|---|---|---|
| **T0 — Always** | Every change, before each commit; on CI when a remote exists | `pnpm check` | typecheck, lint, i18n key parity, fast unit tests (below). No containers, no browser. |
| **T1 — Area-triggered** | When code in that area changes (and before closing the phase that owns it) | `pnpm test:area <area>` (`terminal`, `tmux`, `ssh`) | Integration against the **core** sshd images only (alpine:3 no-tmux, ubuntu:22.04 3.2a, alpine:edge newest packaged) and the small golden set |
| **T2 — Pre-release** | Before tagging a release | `pnpm test:release` + a manual checklist (`docs/release-checklist.md`) | Full tmux matrix (the three D-22 versions), the few E2E flows, chaos/lifecycle, soak, deployment, security and vulnerability scans. The agreed routine is §15.4 (D-25). |

T1 is the middle tier between "always" (T0) and "pre-release" (T2), the two sets D-21 names; the owner confirmed it together with the release routine (D-25).

### 15.3 Test map

The T1 cells name the `pnpm test:area` area that runs them.

| Area | T0 — Always | T1 — When the area changes | T2 — Pre-release | Deliberately not automated |
|---|---|---|---|---|
| WS protocol | codec round trip (all frames/messages) | — | — | — |
| tmux control protocol | parser replaying recorded fixtures: framing, octal unescape, `%extended-output`, FIFO correlation, guard spoofing | `tmux`: restore after daemon restart; `exit` ends the session (3.2a + newest packaged) | full matrix (three versions); network drop; flood/flow control; graceful stop; normal-mode fallback (P7, once its image is approved) | no-tmux notice (checked once; the nested-tmux tip of D-33 has a T0 runtime test and a `tmux` T1 test) |
| Emulator / snapshots | seq + snapshot-barrier bookkeeping; query-silencer coverage; `@xterm/xterm` = `@xterm/headless` version pin | `terminal`: small golden set — snapshot applied to a client vs the server (SerializeAddon output + mode/state probe); capture-rebuild vs live (vim alt screen, wrapped lines, colors, CJK) | large-output (`cat` 200 MiB) | exhaustive escape-sequence coverage (xterm.js's job) |
| Session runtime | state machine + `toSessionStatus`; backoff (fake timers); size policy | — (raw-mode reattach runs under `ssh`) | multi-attach and slow-reader behaviour | — |
| SSH | host-key decision logic + fingerprint normalization | `ssh`: raw-mode reattach on the no-tmux sshd (`serialize()` equality + mode/state probe) | keyboard-interactive/OTP flow | ssh2 internals |
| File panel (§5.12) | name and path checks; SFTP status mapping; listing, conflict pre-checks, remove never following links; pipelined I/O against a fake SFTP (out-of-order replies, errors); transfer URLs (single use, expiry, binding); download headers; request gating and audit; browser transfer queue, conflict names, sorting | `files`: open (home, tmux cwd), list, mkdir, rename, remove, upload and download round trip with a checksum, cancel leaves no partial file | throughput and keystroke latency against a real remote | — |
| Security | authorization isolation (one case per resource type + WS attach + internal API); repository-layer import rule (lint); vault (envelope round trip, AAD, wrong key); WS tickets/Origin (incl. refusal while enrollment is pending, `banned`); internal-API bearer rejection (401, constant-time compare); local-mode gating (flag off; non-admin) | — | security review; OSV scan; CSP check | — |
| Auth (web) | — | — | setup token, login + TOTP + forced password change + lockout (E2E) | Better Auth internals |
| Workspace UI | i18n key parity | — | **signature flow (E2E)**: tabs/splits → close browser → reopen → identical layout and content; daemon restart → restored; manual real-phone check | visual/snapshot tests, styling, CRUD form plumbing (covered by `impeccable` audit rounds instead) |
| Deployment / ops | — | — | clean `compose up` smoke; backup → restore; 24 h soak | — |

### 15.4 Pre-release routine (D-25)

Run before tagging every release, one step at a time (heavy steps never in parallel; memory-capped on small machines):

1. **`pnpm test:release`** ([`scripts/test-release.ts`](../scripts/test-release.ts)) runs these steps strictly in order, stops at the first failure and ends with a summary table (step, duration, PASS/FAIL). `--only <step>[,…]` and `--from <step>` run a subset while debugging; a release needs one full run.
   1. `guard`: fails if `pnpm-lock.yaml` or `node_modules` contain `plain-crypto-js` (any version) or `axios` 1.14.1 / 0.30.4 (GHSA-fw8c-xr5c-95f9, GHSA-2x9r-6wxq-hrr7), and says to treat the machine as compromised.
   2. `t0`: `pnpm check`.
   3. `t1`: every T1 file exactly once, one file at a time. The files are the ones vitest lists for project `t1` (`*.int.test.ts`). Each goes to its `pnpm test:area` area (`terminal`, `ssh`, `tmux`, from [`scripts/test-area.ts`](../scripts/test-area.ts)) or to an `other` group for the suites outside the areas (today the daemon and web integration suites, `apps/session-manager/test/daemon` and `apps/web/test/terminal`); the step prints that mapping and fails unless it covers every file exactly once. The tmux suites run against the whole D-22 matrix (`TD_TMUX_IMAGES=tmux-3.2a,tmux-3.4,tmux-edge`, the T2 column of §15.3) instead of T1's core images. It needs the test sshd containers (`docker compose -f test/sshd/compose.yaml up -d --build`): the step checks that all four answer and never starts or stops them.
   4. `osv`: [`scripts/osv-scan.ts`](../scripts/osv-scan.ts) sends every `name@version` key of the lockfile's `packages:` section to `https://api.osv.dev/v1/querybatch` (Node built-ins only, no YAML parser). Any advisory not accepted in [`scripts/osv-allowlist.json`](../scripts/osv-allowlist.json) for that exact `name@version` (each entry: id, package, reason, review date) fails the step, and so does a network failure. Accepted today: GHSA-67mh-4wv8-2f99 in esbuild 0.18.20 (moderate; dev-only, pulled in by drizzle-kit).
   5. `build`: `docker compose -p termdock-smoke -f deploy/compose.yaml build`, session-manager then web.
   6. `smoke`: [`scripts/release-smoke.ts`](../scripts/release-smoke.ts) against the composed stack (next paragraph).
   7. `smoke-proxy`: the same smoke with `--proxy` (D-35): the stack runs with `TERMDOCK_TLS=off` and `TERMDOCK_REVERSE_PROXY` set to the edge gateway, behind a front proxy that terminates TLS as nginx would (a second Caddy from the deployment's pinned image, on the host network at `127.0.0.1:18543`, forwarding to Caddy's plain-HTTP port). Instead of the certificate check it checks that Caddy answers plain HTTP without a redirect, and at the backup step that every address stored in `session_events` and `audit_events` is the browser's (`127.0.0.1`), never the proxy's.

   Heavy steps (`t0`, each T1 file, the smoke) run under `systemd-run --user --scope -p MemoryMax=${TERMDOCK_RELEASE_MEMORY_MAX:-1500M} -p MemorySwapMax=0` when a user systemd is available, plain otherwise. The image builds run inside dockerd, outside that cap, so they run alone.

   **The smoke** is isolated from any real install: compose project `termdock-smoke`, throwaway named volumes, secrets from `init-secrets.sh` in a temporary directory, Caddy on `127.0.0.1:18080` / `127.0.0.1:18443`, and the test-only override [`test/release/compose.smoke.yaml`](../test/release/compose.smoke.yaml), which adds a test sshd (the already-built `termdock-test-sshd:tmux-3.4` image, test-only keys) on the edge network and moves the edge subnet off the deployment's `172.30.10.0/24`. The deploy scripts reach that stack through opt-in variables (`COMPOSE_PROJECT_NAME`, which docker compose reads itself, plus `TERMDOCK_COMPOSE_OVERRIDE`, `TERMDOCK_SECRETS_DIR` and `TERMDOCK_BACKUP_DIR`); unset, they behave exactly as before. Once the stack is up, the certificate Caddy serves (`TERMDOCK_TLS=internal`) must be valid for at least 25 more days (D-34). The flow:
   1. the one-time setup token from web's log, the first admin at `/setup` (then `/setup` is a 404);
   2. sign out, sign in at `/login`;
   3. "Add server" (D-29) in one form: the server (the test sshd: name, address, port, user name) and the pasted test private key as a new credential; the result shows in place with the key's fingerprint (checked), and its "Start a session" lands in the workspace through `/workspace?open=<id>`, which opens that session in the focused pane and cleans the URL;
   4. that session: trust the host key on first use (fingerprint checked), then Connected and protected;
   5. `echo termdock-smoke-<random>`, read back from xterm's rows;
   6. rename the session through its menu's "Rename…" dialog (D-28): the new name shows on its row and its tab;
   7. restart session-manager: the pane shows "Restoring…", then Connected with the earlier output still on screen;
   8. `deploy/scripts/rotate-master-key.sh --yes`, then a new session from the server in the palette connects with the same credential (it decrypts under the new key);
   9. Duplicate the server on its page and save the copy unchanged (same address, same saved credential); a session from the copy connects with no host-key prompt, since trust is per address (D-29);
   10. terminate all three sessions;
   11. `deploy/scripts/reset-password.sh --reset-totp` for the admin (D-36): the browser's sign-in has ended, the printed temporary password signs in, and the forced password change leads back to the workspace;
   12. `deploy/scripts/backup.sh`: a backup file that passes the script's integrity check, checked again on the host copy (`node:sqlite`): two servers at the same address with the same credential, exactly one trusted `known_host_keys` row for that address, the renamed session's stored label, and the `auth.password_reset` and `auth.totp_reset` rows from the operator.

   It also fails on any CSP violation the browser reports during the flow (Phase 8 H). Every check prints a PASS/FAIL line; on failure the smoke saves a screenshot and the last 100 log lines of each service to a temporary directory and prints its path. It always tears down, also on failure and Ctrl-C: `docker compose -p termdock-smoke down -v` (that project only) and the temporary secrets. The `termdock-smoke-*` images stay for the next run.

   **Chromium is required for the smoke, and is not a new dependency.** The smoke drives the real web UI over the Chrome DevTools Protocol in a locally installed headless Chromium: `TERMDOCK_SMOKE_CHROME`, else the newest `~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell`; without one it fails with an explanation. The browser is a machine prerequisite like Docker, and the CDP client ([`scripts/cdp.ts`](../scripts/cdp.ts)) is a few hundred lines on Node 24's built-in WebSocket client: no browser-automation package, nothing added to the lockfile. The browser gets a throwaway profile, accepts Caddy's local CA for that run only (`--ignore-certificate-errors`) and runs without WebGL, so xterm uses its DOM renderer and the smoke can read the terminal rows.
2. Manual checklist ([`docs/release-checklist.md`](release-checklist.md)): real phone, both locales, host-key mismatch UX, a keyboard-interactive/OTP host, backup → restore on a scratch install, the project site (D-40), CHANGELOG and version, tag.
3. Security review for releases that touch auth, the vault, WS or the internal API.

The routine adds no browser-automation package and has no soak (owner choice); the T2 column of §15.3 items not covered above are verified once at delivery or run ad hoc.

---

## 16. Execution with `/ats-orchestrator`

The implementation is meant to run under the `ats-orchestrator` posture: the session model orchestrates (architecture, canonical contracts, integration, review) and implementation goes to tiered subagents.

### 16.1 What the orchestrator keeps

- The canonical contracts of Phase 0 (`packages/protocol` incl. the internal-API schemas, `packages/db` schema, `core/types.ts` — `Transport`, `Driver`, `DriverContext`, `Emulator`, `SessionHost`, `AttachmentHandle`, `CredentialProvider` —, `toSessionStatus`, `terminal-config` incl. the query silencer and the mode tracker, error codes, i18n conventions). **They are fixed before any fan-out**, so parallel tracks cannot diverge.
- Integration across tracks (protocol ↔ UI ↔ daemon; schema ↔ both apps).
- Final verification of every phase's exit criteria, re-run independently; reading key deliverables in full; checking seams.

### 16.2 Work-package routing

| Work package | Tier / effort | Why |
|---|---|---|
| Spikes S1, S2, S4, S5, S6 | `opus` / `xhigh` | Standard engineering investigation from a written spec |
| Spike S3 (snapshot boundary) and `TmuxControlDriver` snapshot/rebuild | `opus` / `max` | Correctness-critical; errors are subtle and expensive |
| Vault, WS tickets, internal-API auth | `opus` / `max` | Security-critical correctness |
| Transport, raw driver, runtime, attachments, WS server | `opus` / `xhigh` | Default implementation |
| Next.js shell, Better Auth integration, workspace UI, mobile key bar | `opus` / `xhigh` | Default implementation with UI judgment |
| CRUD pages after the first reference page exists | `sonnet` / `high` | Boilerplate replication of a fixed pattern |
| `test/sshd` images after the first reference image | `sonnet` / `high` | Mechanical replication |
| pt-BR translation of a complete `en.json`; string-extraction sweeps | `sonnet` / `high` | Deterministic spec, trivial verification (key parity) |
| Inventories (call sites, untranslated strings, TODO lists) | `haiku` / `medium` | Read-only lookups the orchestrator verifies |
| Pre-release security review (Phase 8 A) | `fable` / `xhigh` (defensive framing) | Deep defensive analysis of our own code; `max` only if it is inconclusive |
| A protocol or desync bug that survives an `opus` pass | `fable` / `xhigh` | Escalation rule |
| `impeccable` foundation (`init`, `shape`, visual world / `DESIGN.md`) | orchestrator, or `opus` / `xhigh` with owner review | Design direction is a judgment call |
| `impeccable` critique / audit rounds per UI block | `opus` / `xhigh` | Evaluation with the skill's references; findings are fixed in the same block |

Every delegation follows the contract: context, objective, hard constraints, labeled acceptance criteria with commands, and a PASS/FAIL report with real output. Subagents never touch the git index or commit.

### 16.2.1 Delivery and commits (D-20)

For each functional block:

1. The orchestrator verifies the exit criteria: runs the whole-repo `pnpm check` (T0), plus T1 if the block touched that area, plus the block's `[once]` checks.
2. It reviews the diff.
3. It commits **only the files belonging to that block** (message ≤ 2 lines, no trailers).
4. Files the owner created (e.g. vendored skills) are never committed without asking.
5. Push to `origin main` after each verified commit.

### 16.2.2 Shared working tree

Parallel agents share one working tree, so:

- Only the orchestrator edits the root `package.json` and the lockfile, and only the orchestrator runs `drizzle-kit generate`. Implementer agents request dependency or schema changes in their report.
- Agents run filtered checks (`pnpm --filter <pkg> typecheck`, their area's tests). The whole-repo `pnpm check` runs at integration points and before each commit.
- No git worktrees unless the owner approves.

### 16.3 Suggested fan-out after Phase 0

- Track A (one agent at a time, sequential): P1 → P3 → P4 (including the vault, the internal API and the host-key routes).
- Track B in parallel: P2, against the internal-API schemas fixed in Phase 0.
- Track C in parallel: P5 against the mock WS server.
- The orchestrator integrates at the P2/P4/P5 seams and runs the integration step (§14), then P6 ∥ P7 (P6 needs P2 and P4), then P8.

---

## 17. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Snapshot-boundary assumption in tmux control mode is wrong under load | Garbled screen after reconnect | Spike S3 with golden tests before Track A; fallback: pause output (`refresh-client -A %p:pause`) around capture |
| Control-protocol complexity (desyncs, version quirks) | Bugs in the core promise | Version matrix in CI; desync → reattach + full resync (never kill the session); fallback to `none` with a banner |
| `KillUserProcesses=yes` kills tmux on remotes | Protection ineffective | Probe reads it via `busctl` plus linger; `systemd-run --user --scope` launch when linger is on; otherwise a visible "enable linger" warning, never a silent protection claim (§5.11); S5 |
| Serialize addon does not restore every terminal mode | Wrong mouse encoding, cursor style or tab stops after browser reattach | Mode tracker + mode epilogue (§5.3.1); P1 B mode/state probe; S1 enumerates the gaps; remaining gaps documented |
| Emulator memory: measured ~18 MiB per session at 10k lines × 120 cols (4 MiB JS heap + 14 MiB cell arrays, ADR-0001) | High RSS with many sessions | Default 5k lines, configurable per profile; documented budget; soak test; roadmap: compress idle scrollback |
| Snapshot serialization blocks the daemon event loop (~85 ms at 5k lines, ~550 ms at 10k) | Input/output latency spikes for every session while one attaches | Snapshot cache per (session, seq); resizes are sequenced events, not snapshots (§5.5); default 5k lines; roadmap: serialize in a worker thread |
| Emulator relies on xterm 6.0.0 internals (parser state, current attributes) for the parser tail and last-cell reprint (ADR-0001) | Breaks silently on an xterm upgrade | Version pinned on both sides with a T0 test; golden + barrier tests must pass before any xterm bump |
| Snapshot cost (`snapshot()` on 10k lines; `%pause`-triggered rebuilds) | CPU spikes and latency on resize, lag and flow control | Measured in S1/S4; one cached snapshot per (session, seq) shared by all attachments (§5.4) |
| Width-table mismatch (tmux vs xterm.js) for emoji/CJK | Misaligned rows after reattach-from-capture | unicode11 on both xterm sides; golden tests; documented limitation |
| Better Auth plugin fit (username needs email, SQLite adapter, lockout per username+IP, forced password change, forced TOTP enrollment, admin TOTP reset) | Rework of auth | Spike S6 go/no-go per item; Termdock implements missing pieces (e.g. lockout); fallback: minimal hand-rolled auth on the same tables |
| Native modules (node-pty, better-sqlite3) on Node 24/26 and arm64 | Build failures | Bundled prebuilds with dependency build scripts blocked by `allowBuilds` (§12); any build exception decided explicitly; CI on amd64 + arm64; `node:sqlite` as a future replacement |
| TypeScript 7 tooling compatibility | Lint/build friction | Pinned to TypeScript 6.0.3 (TS 7 rewrote the compiler; Next.js/tooling compatibility unverified); revisit after the MVP |
| Multi-process SQLite on Docker volumes | Lock contention (SQLite serializes writers globally) | WAL; the daemon's batched writer with short transactions and `busy_timeout` 250 ms + retry; web at 5000 ms; chunked purges (§9); local volumes only, and a Linux host when the daemon runs on the host |
| tmux < 3.2 fleets (RHEL 8) | Reduced protection | Phase 7 normal-mode fallback (untested until an image with tmux < 3.2 is approved, Phase 7) |

---

## 18. Post-MVP roadmap

### 18.1 Daemon + one worker process per session (recorded per D-07)

Each session runs in its own detached **session host** process (`termdock-session-host`), holding the transport, driver and emulator, and exposing a Unix socket. The daemon becomes a supervisor/router. On daemon restart it rediscovers live session hosts by their sockets and reattaches. Benefits: **unprotected sessions survive daemon crashes and upgrades**, and a fault in one session cannot take down the others. Preparation in MVP: `SessionRuntime` sits behind an interface (`SessionHost`, frozen in Phase 0, §5.1) with an in-process implementation, and the attachment protocol is already message-based, so moving it out of process is mechanical. Open design points: session-host versioning during upgrades, resource limits per host, socket permissions.

### 18.2 Other items

- **Agent mode**: a lightweight agent on target servers opens an outbound WSS connection to the control plane (no inbound SSH needed) and runs local PTYs/tmux.
- Jump hosts (ProxyJump via ssh2 `forwardOut` + `sock`), SSH agent forwarding, OpenSSH certificates.
- RBAC (admin/operator/viewer), shared hosts/credentials, session sharing (read-only or collaborative) and handoff links.
- Opt-in encrypted terminal recording with retention policy, kept separate from the audit metadata.
- PostgreSQL support (Drizzle dialect switch) for larger installs; HA requires session-host affinity.
- Secret backends: HashiCorp Vault, AWS/GCP/Azure secret managers / KMS-wrapped KEK.
- SSO/OIDC, passkeys (WebAuthn).
- Optional encrypted periodic checkpoints of unprotected emulators (restore the last screen read-only after a restart).
- Per-attachment "lock size" and "follow" modes; notifications (bell/activity/command finished); a CLI client attaching over the same protocol; emulator memory compaction for idle sessions.
- File panel follow-ups (§5.12): folder download (an archive), folder upload, permissions (chmod), creating links, file editing.

---

## 19. Open items (non-blocking; defaults apply until the owner decides)

| Item | Default until decided |
|---|---|
| Default scrollback size | 5,000 lines (snapshot CPU and memory trade-off, §5.4, §17) |
| Default `auto_reopen` for unprotected sessions | On, with banner |
| Web auth-session lifetime | 7 days sliding (Better Auth `expiresIn` 7 days, `updateAge` 1 day); no idle-timeout setting |
| Public repository/organization name | Not decided |
| Test image with tmux < 3.2 (Phase 7) | None approved (D-22); the normal-mode fallback stays untested until the owner approves one when P7 starts |
| Security contact channel | None yet (`SECURITY.md` and `docs/security.md` say so); an email address or GitHub private vulnerability reporting is needed before the repository goes public |
| UI font sign-off (D-26) | Plus Jakarta Sans on trial; `@fontsource-variable/archivo` stays in `apps/web/package.json`, unused, until the owner signs off, then it is removed |
| Sub-path behind a reverse proxy | Not supported: Termdock needs its own name at the root (D-35). A sub-path such as `/termdock` would need `TERMDOCK_BASE_PATH` as a build setting (Next.js inlines `basePath`, so changing it means an image rebuild), Caddy routing `<path>/ws`, and an audit of fixed paths (`/ws`, `fetch('/api/...')`, redirects, auth cookies). |
| Disabled account at sign-in (review 2026-10-19) | Better Auth checks the password before the ban, so "account disabled" appears only after a correct password: it confirms a disabled user's password to whoever guesses it (guesses still go through the lockout and the IP budget). Kept, so disabled users learn why; the alternative is the generic "invalid username or password" for them too. |
| IPv6 clients on the default compose (review 2026-10-19) | The `edge` network is IPv4-only, so Docker forwards IPv6 clients through its userland proxy from the gateway address and Termdock sees them as one client (documented in `docs/security.md` "Other limits", with `TERMDOCK_BIND_ADDRESS=0.0.0.0` as the workaround). Giving `edge` IPv6 depends on the Docker version and the host's IPv6 setup, so the compose file stays as is until the owner decides. |
| Caddy as a non-root user (review 2026-10-19) | Caddy runs as root inside its container (the official image's default) with every capability but `NET_BIND_SERVICE` dropped. Running it as `10001` needs `ip_unprivileged_port_start`, the `caddy-data`/`caddy-config` volumes re-owned on existing installs and an upgrade note; not done yet. |
| ssh2 ed25519 key generation bug | `generateKeyPairSync('ed25519')` emits a key that does not parse back about once in 400; worked around in `vault/credentials.ts` (`generateEd25519Key`, retries); reporting it upstream waits for the owner's OK |

---

## Appendix A — Research references

- tmux control mode: <https://github.com/tmux/tmux/wiki/Control-Mode>, man page <https://man.openbsd.org/tmux>, CHANGES <https://github.com/tmux/tmux/blob/master/CHANGES> (3.8 released 2026-09-09).
- iTerm2 tmux integration: <https://iterm2.com/documentation-tmux-integration.html>, best practices <https://gitlab.com/gnachman/iterm2/-/wikis/tmux-Integration-Best-Practices>, source `sources/tmux/` (TmuxGateway.m, TmuxController.m, TmuxWindowOpener.m).
- xterm.js serialize addon typings: <https://github.com/xtermjs/xterm.js/blob/master/addons/addon-serialize/typings/addon-serialize.d.ts>; VS Code pty host revive: `src/vs/platform/terminal/node/ptyService.ts`.
- ssh2: <https://github.com/mscdex/ssh2>.
- Node.js release schedule: <https://github.com/nodejs/Release>.
- Better Auth username / 2FA plugins: <https://better-auth.com/docs/plugins/username>, <https://better-auth.com/docs/plugins/2fa>.
- Drizzle SQLite drivers: <https://orm.drizzle.team/docs/get-started-sqlite>.

Versions verified on npm on 2026-10-15 (to be pinned in Phase 0): next 16.4.1 · react 19.3.1 · @xterm/xterm 6.0.0 · @xterm/headless 6.0.0 · @xterm/addon-serialize 0.14.0 · @xterm/addon-fit 0.11.0 · @xterm/addon-webgl 0.19.0 · @xterm/addon-unicode11 0.9.0 · @xterm/addon-search 0.16.0 · @xterm/addon-web-links 0.12.0 · ssh2 1.17.0 · node-pty 1.1.0 · drizzle-orm 0.45.4 · drizzle-kit 0.31.11 · better-sqlite3 13.0.3 · better-auth 1.7.10 · next-intl 4.14.9 · zod 4.6.7 · ws 8.22.0 · pino 10.4.0 · @playwright/test 1.64.1 · tailwindcss 4.3.3.

Pinned at scaffolding: typescript 6.0.3 (TS 7 not adopted, §12) · vitest 5.0.4 (pinned to a version older than pnpm's minimum release age) · @types/node 24.19.2 · @biomejs/biome 2.5.15 · pnpm 11.13.0 (the local package manager, `packageManager` field).
