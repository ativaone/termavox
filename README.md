<div align="center">

# Termdock

**Your terminals, docked. Close the browser, come back anywhere, and pick up exactly where you left off.**

A self-hosted, persistent terminal-session runtime for SSH, accessible from the web.

[![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange)](#status-and-roadmap)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24_LTS-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![xterm.js](https://img.shields.io/badge/xterm.js-6-2F2F2F)](https://xtermjs.org/)
[![tmux](https://img.shields.io/badge/tmux-control_mode-1BB91F?logo=tmux&logoColor=white)](https://github.com/tmux/tmux)
[![SQLite](https://img.shields.io/badge/SQLite-Drizzle-003B57?logo=sqlite&logoColor=white)](https://orm.drizzle.team/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![pnpm](https://img.shields.io/badge/pnpm-workspaces-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Vitest](https://img.shields.io/badge/tested_with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![Biome](https://img.shields.io/badge/lint-Biome-60A5FA?logo=biome&logoColor=white)](https://biomejs.dev/)

</div>

---

<p align="center">
  <a href="docs/screenshots/README.md"><img src="docs/screenshots/workspace.png" alt="The Termdock workspace: named sessions on the left, a live shell on the right" width="900"></a>
</p>

<details>
<summary><b>More screenshots</b> (first use, adding a server, a server's page, the phone)</summary>
<br>

| First use | Add server |
|---|---|
| <img src="docs/screenshots/first-run.png" alt="First use: connect your first server" width="440"> | <img src="docs/screenshots/add-server.png" alt="Add server: the server and its credential on one page" width="440"> |
| **Server added** | **A server's page** |
| <img src="docs/screenshots/add-server-done.png" alt="Server added: the public key and the command that installs it" width="440"> | <img src="docs/screenshots/server.png" alt="A server's page: details, diagnostics and host keys" width="440"> |

| On the phone | |
|---|---|
| <img src="docs/screenshots/phone-sessions.png" alt="The session list on a phone" width="260"> | <img src="docs/screenshots/phone-session.png" alt="A session on a phone, with the extra-key bar and Alt armed" width="260"> |

All screens, with notes: [docs/screenshots](docs/screenshots/README.md).
</details>

## The idea

In most web SSH tools, the browser tab **is** the session: close the laptop or lose Wi-Fi, and the connection dies with it. Termdock flips that around.

> **The browser lifecycle is not the terminal lifecycle.**

Termdock runs on a server you control and holds your SSH sessions open **on the server side**, indefinitely, until you decide to end them. Browsers only *attach* and *detach*. When you come back, from the same laptop, another computer or your phone, every terminal is exactly as you left it. You get the same screen, cursor, colors and scrollback, with `vim` or `htop` still running.

Think of it as tmux, but the "client" is any browser, the sessions live in a service rather than in a terminal window, and you never have to type `tmux attach` again.

## Why it is different

| What happens… | Typical web SSH | Termdock |
|---|---|---|
| You close the browser tab | The SSH session dies | Nothing; the session keeps running |
| You reopen it on another device | You start over | Same screen, instantly, including full-screen apps |
| Your Wi-Fi drops for a minute | The session is lost | It reconnects behind the scenes; the shell never noticed |
| The Termdock service restarts | — | Protected sessions come back as they were ("Restoring…") |
| Two devices open the same session | Usually not supported | Both attach; the one you are typing on sets the size |

## How it works

```mermaid
flowchart LR
  subgraph B["Any browser · laptop or phone"]
    V["xterm.js view<br/>(renderer + keyboard)"]
  end
  subgraph T["Termdock · self-hosted"]
    W["web<br/>Next.js control plane<br/>users · servers · login + TOTP"]
    S["session-manager<br/>Node.js data plane<br/>authoritative terminal emulators"]
  end
  subgraph R["Your servers"]
    X["invisible tmux<br/>shell · vim · htop …"]
  end
  V -- "HTTPS" --> W
  V -- "WebSocket<br/>snapshot + live output" --> S
  W -- "internal API" --> S
  S -- "SSH · tmux control mode" --> X
```

Three ideas carry the design:

1. **A terminal emulator lives on the server.** For every session, `session-manager` keeps an authoritative [`@xterm/headless`](https://github.com/xtermjs/xterm.js) instance fed with the raw SSH output. When a browser attaches, it receives a serialized **snapshot** of that state followed by the live byte stream, so it renders an exact copy, alternate screen and terminal modes included.
2. **tmux protects sessions, and you never see it.** Every SSH session automatically runs inside a dedicated remote tmux server, driven through tmux's **control mode** (the same technique as iTerm2's tmux integration). tmux draws nothing: no status bar, no prefix key, and scrollback stays normal. If the network drops or Termdock restarts, it reattaches and rebuilds the screen and history from tmux. Servers without tmux still work; the session is simply marked as *not protected*.
3. **Sessions are owned by the service, not the browser.** The web app (control plane) manages users, servers, credentials and layout. The session-manager (data plane) owns connections, emulators and reconnection. Deploying a new web version never drops a terminal.

## Features (v0.1 goals)

- 🖥️ **Persistent SSH sessions** that survive closed tabs, flaky networks and service restarts.
- 🛡️ **Automatic, invisible tmux protection**, with auto-detection and graceful fallback.
- 🪟 **Workspace** with a session sidebar, tabs and split panes. Your layout is saved on the server and restored in any browser.
- 📱 **Usable from a phone**, with a responsive layout and an extra-key bar (Esc, Ctrl, Tab, arrows…).
- 👥 **Multi-user with strict isolation**: each user sees only their own servers, credentials and sessions.
- 🔐 **Built like a bastion**:
  - Credentials are encrypted with a key that only the data plane holds.
  - Host keys are verified with explicit trust on first use and a hard fail on mismatch.
  - Login uses username/password plus optional TOTP, with rate limits.
  - Audit logs record session and security events.
- 🔑 **SSH authentication** with private keys (with passphrase), passwords, and keyboard-interactive prompts (OTP/2FA) relayed to your browser.
- 🏠 **Local modes**: the "This Docker host" preset (available) adds the machine running Termdock as an SSH host; direct mode, a local shell without SSH, is planned (Phase 6).
- 🌍 **English and Brazilian Portuguese** UI.
- 🐳 **One-command deployment** with Docker Compose and Caddy (automatic HTTPS).

## Status and roadmap

> [!WARNING]
> Termdock is **pre-alpha**. The runtime, the web workspace and the Docker deployment work end to end and have had an internal security review, but there is no release yet. Keep it away from production servers until v0.1.0.

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundations, canonical contracts, de-risking spikes: emulator fidelity, tmux control protocol, state rebuild under load, flow control, lifecycle (all GO, see ADRs) | ✅ |
| 1 | Data plane core: session runtime, WebSocket protocol, raw SSH driver, SQLite persistence, credential vault, internal API, daemon boot, dev CLI | ✅ |
| 2 | Web control plane: login + TOTP, admin, servers/credentials, audit, i18n (English, Brazilian Portuguese) | ✅ |
| 3 | tmux control-mode protection end to end: restore after daemon restarts and network drops, verified on tmux 3.2a, 3.4 and 3.8 | ✅ |
| 4 | Resilience: reconnect, host-key trust, keyboard-interactive flows | ✅ |
| 5 | Workspace UI: sidebar, tabs, splits, mobile key bar, Docker Compose deployment | ✅ |
| 6 | Local modes: the "This Docker host" preset ships; direct mode is pending | 🚧 |
| 7 | Compatibility fallback for old tmux versions | ⏳ |
| 8 | Hardening, security review, docs, release v0.1.0 (review and hardening done) | 🚧 |

The full plan, with architecture, protocol, data model, security model and per-phase exit criteria, lives in [`docs/implementation-plan.md`](docs/implementation-plan.md). Spike results are recorded as ADRs in [`docs/adr/`](docs/adr/README.md).

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict) everywhere, ESM, Node.js 24 LTS (runs `.ts` directly) |
| Web / control plane | Next.js 16 (App Router), React 19, Tailwind CSS 4, Better Auth, next-intl |
| Data plane | Node.js daemon with `ssh2`, `@xterm/headless` + `@xterm/addon-serialize`, `ws` |
| Persistence | SQLite (WAL) through Drizzle ORM, ready for PostgreSQL later |
| Protection | tmux ≥ 3.2 in control mode on the remote host |
| Deployment | Docker Compose + Caddy |
| Tooling | pnpm workspaces, Biome, Vitest, dockerized sshd test matrix |

## Getting started

### Run it with Docker

One command starts the three containers behind a single origin: **Caddy** (TLS), **web** and **session-manager**. You need **Docker** with Compose v2 on a Linux host.

```bash
deploy/scripts/init-secrets.sh                      # generate the secrets; back up deploy/secrets/master_key
docker compose -f deploy/compose.yaml up -d --build # build both images and start the stack
docker compose -f deploy/compose.yaml logs web      # the one-time token to create the first admin at /setup
```

Out of the box it serves `https://localhost` with a certificate from Caddy's local CA. The [installation guide](docs/guides/install.md) covers domains and TLS, backups and restore, upgrades and troubleshooting. Termdock is still pre-alpha, so keep it away from production servers for now.

**Upgrading an existing install:** read the version's upgrade notes in [CHANGELOG.md](CHANGELOG.md), back up, `git pull`, then `docker compose -f deploy/compose.yaml up -d --build`. Database migrations run on their own; the full procedure is in [Upgrades](docs/guides/install.md#upgrades).

### Development

You need **Node.js 24**, **pnpm 11** and **Docker** (for the test SSH servers).

```bash
pnpm install                                   # dependency build scripts are blocked by policy
docker compose -f test/sshd/compose.yaml up -d # test sshd containers: no tmux, tmux 3.2a, 3.4, newest
pnpm check                                     # typecheck + lint + fast tests (T0)
pnpm test:area tmux                            # integration tests for one area (terminal | ssh | tmux)
pnpm test:release                              # pre-release routine: T0, all T1, OSV, image builds, smoke
```

The test containers listen on `127.0.0.1:2201–2204` and use **test-only** keys from [`test/sshd/keys/`](test/sshd/keys/). Never reuse them anywhere else.

Before a release, `pnpm test:release` runs the automated routine (its smoke drives the real UI in a local headless Chromium over the DevTools protocol), followed by the manual [release checklist](docs/release-checklist.md); see plan §15.4.

### Repository layout

```text
apps/
  session-manager/   Node.js daemon: transports, drivers (raw PTY, tmux control mode),
                     server-side emulators, session runtime, WebSocket server
  web/               Next.js control plane (UI, auth, admin)
packages/
  protocol/          WebSocket protocol v1, internal API schemas, WS tickets
  db/                Drizzle schema and migrations (SQLite)
  terminal-config/   xterm options shared by server and browser, query silencer, mode tracker
  shared/            ids, error codes
deploy/              Docker Compose stack, Caddyfile, Dockerfiles, secrets/backup/restore scripts
scripts/             dev CLI, test runners (T1 areas, pre-release routine) and the release smoke
test/sshd/           SSH server images used by the integration tests
test/release/        test-only compose override for the release smoke
docs/                guides, security model, architecture overview, implementation plan, ADRs
```

## Documentation

| Document | What it covers |
|---|---|
| [Installation guide](docs/guides/install.md) | Running Termdock with Docker Compose: secrets, domains and TLS, backups, upgrades, troubleshooting |
| [Configuration reference](docs/guides/configuration.md) | Every environment variable, secret file, port, volume and instance setting |
| [Security model](docs/security.md) | Trust boundaries, threat model, controls and operator recommendations |
| [Architecture overview](docs/architecture.md) | Components, session lifecycle, protection modes, protocol and persistence, for contributors |
| [Implementation plan](docs/implementation-plan.md) | The full design, decision log and phased delivery plan |
| [Architecture decision records](docs/adr/README.md) | Spike outcomes and design decisions |
| [Release checklist](docs/release-checklist.md) | The manual half of the pre-release routine, after `pnpm test:release` |

## Security

Termdock is designed to be deployed as a **privileged bastion**: whoever controls it can reach every registered server. The design reflects that:

- SSH secrets are encrypted at rest (AES-256-GCM) and can only be decrypted by the data plane.
- There is no `StrictHostKeyChecking=no` anywhere.
- WebSockets authenticate with short-lived, single-use tickets.
- Every request is scoped to its owner.
- Terminal contents are never logged.

The threat model, the controls and what Termdock does *not* protect against are described in the [security model](docs/security.md). An internal pre-release security review has been completed and its findings fixed; please still wait for the first release before using Termdock in production. To report a vulnerability, see [`SECURITY.md`](SECURITY.md).

## License

Termdock is free software, licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). If you run a modified version as a network service, the AGPL requires you to offer its source to the users of that service.

---

<div align="center">
<sub>Termdock — a terminal that stays docked while you are away.</sub>
</div>
