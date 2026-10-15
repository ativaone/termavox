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

Other protocols (RDP/VNC); Agent mode (outbound agent on target servers); RBAC and sharing hosts/sessions between users; terminal recording; HA/multi-instance; jump hosts (ProxyJump); SSH agent forwarding; SFTP/file transfer; SSO/OIDC; passkeys. All of these are in the roadmap (§18).

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
| D-20 | **Commit in this repository as each functional block is delivered.** No git remote yet, so no push for now. | Owner, 2026-10-15 |
| D-21 | **Lean, risk-based automated testing.** Test what really needs testing. Tests are mapped into an always-run fast set and a full pre-release battery; the exact pre-release routine is still to be defined with the owner (§15). | Owner, 2026-10-15 |
| D-22 | Test container matrix reduced to alpine:3 (no tmux), ubuntu:22.04 (3.2a), ubuntu:24.04 (3.4), alpine:edge (newest packaged). Base images for deployment (node, caddy) are approved when the deploy phase starts. | Owner, 2026-10-15 |

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

---

## 3. Glossary (canonical terms)

These names are used in code, the database, the protocol and the UI. **Do not introduce synonyms.**

| Term | Meaning |
|---|---|
| **Host** | A machine known to Termdock (`kind: ssh` with hostname/port, or `kind: local` for direct mode). Owned by one user. |
| **Credential** | Secret material used to authenticate: a password, or a private key with an optional passphrase. Stored encrypted; owned by one user. |
| **Connection profile** | *How* to connect: host + username + credential + options (protection mode, startup command, TERM, env, keepalive, auto-reopen, scrollback lines). |
| **Session** | A live terminal created from a profile. Exists independently of any browser. Snapshots its target (host, port, username, credential) at creation (§9). Has an internal **state** and a user-facing **status**. |
| **Attachment** | One browser view attached to a session through a WebSocket channel. A session has 0..N attachments. |
| **Active attachment** | The attachment that most recently sent input or explicitly took focus; it drives the session size. |
| **Auth session** | A logged-in web session (Better Auth). Never call this just "session" in code: use `authSession`. |
| **Transport** | How bytes reach the target: `SshTransport` (ssh2) or `LocalTransport` (child_process / node-pty). |
| **Driver** | How the terminal is run over a transport: `RawPtyDriver`, `TmuxControlDriver`, or `TmuxNormalDriver`. |
| **Emulator** | The server-side headless xterm instance holding the authoritative screen state of one session. Owned by the session runtime; drivers never touch it directly. |
| **Protection mode** | The connection-profile setting `protection_mode`: `auto` (default) or `off`. |
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
│ Users, hosts, credentials*,  │  │                                         │
│ profiles, layout, audit view │  │ Session registry & state machines       │
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
| Hosts, profiles, layout, preferences | owns (CRUD) | reads (a session snapshots its target at creation, §9) |
| Credentials | UI; create/delete through the internal API | **writes every `credentials` row; encrypts/decrypts; sole holder of the KEK** |
| Known host keys | UI for trust decisions, through the internal API | verifies on connect; **writes every `known_host_keys` row** (pending, trust, replace, revoke) |
| Sessions | requests create/terminate/retry/reopen via the internal API; reads history | **owns runtime and lifecycle; writes `sessions` and `session_events`** |
| Terminal I/O | — | WebSocket, emulators, drivers, transports |
| Instance settings | writes every key except the two on the right | writes `installation_id` and `vault_key_check` |
| Audit | writes auth/admin events; displays the log | writes host-key and credential audit events |

The full per-table write-ownership list is in §9.

**Source of truth.** The `session-manager` process is the source of truth for whether a session is alive and in what state. The database records the *desired* state (`desired_state`), the last known status, and the history. On boot, the daemon reconciles the database against reality (§5.8).

### 4.3 Network and ports

| Listener | Exposure | Purpose |
|---|---|---|
| Caddy `:80/:443` | public | TLS termination; `/ws` → `session-manager:3001`; everything else → `web:3000` |
| web `:3000` | compose network `edge` only (via Caddy) | Next.js |
| session-manager `:3001` | compose network `edge` only (via Caddy) | WebSocket attachments |
| session-manager `:3002` | compose network **`internal` only** (web ↔ session-manager); Caddy is not on `internal`, so it can never route here | Internal API, bearer token |

Compose networks: `edge` connects caddy ↔ web and caddy ↔ session-manager (`:3001`); `internal` connects web ↔ session-manager (`:3002`).

Single origin: the browser talks to one origin, so cookies stay `SameSite=Strict` and there is no CORS.

**Client IP.** Caddy is the only trusted proxy. Better Auth's `advanced.ipAddress` reads `X-Forwarded-For` as set by Caddy (rate limits, lockout, audit); session-manager trusts `X-Forwarded-For` only on connections from Caddy's address and otherwise uses the socket address.

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
  snapshot(): string;                                   // SerializeAddon output + mode epilogue (§5.3.1); call after flush()
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

- One `@xterm/headless` `Terminal` per session, built from `packages/terminal-config` (same options and Unicode provider as the browser). Scrollback is the session's `scrollback_lines`, taken from the profile (default **10,000 lines**; memory budget in §17). It is authoritative everywhere: the server emulator, tmux `history-limit` (§6.3) and the browser, which receives it in `session.attached` (§7.3).
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
4. **Snapshot barrier** (on attach, resize or resync): enqueue `term.write('', cb)`. When the callback fires, every previously written chunk has been parsed, so call `snapshot()` synchronously (SerializeAddon `serialize()` + the mode epilogue, §5.3.1) and record `snapshotSeq` = the last seq written before the barrier. Send `SNAPSHOT(snapshotSeq, cols, rows)` (§7.2) and then only chunks with `seq > snapshotSeq`. **[SPIKE S1]** Confirm that write callbacks run synchronously between chunks in xterm 6's write buffer, so serialization is consistent at the barrier.
5. **Snapshot cache**: one serialized snapshot per (session, seq), shared by every attachment that needs it at that point (e.g. all attachments after a resize).
6. The client applies a snapshot as: `term.reset()` → `term.resize(cols, rows)` from the frame header → `term.write(snapshot)`. While a `SNAPSHOT` for a channel is being decompressed and applied, the client queues that channel's `OUTPUT` frames; afterwards it drops those with `seq <= snapshotSeq` and applies the rest in order. A client can ask for a fresh snapshot at any time with `terminal.resync { channel }` (e.g. after a decode error).
7. The client and server parse identical bytes at identical sizes with the identical engine version, so they remain identical. A resync is cheap and is used on every resize and whenever there is doubt: lag, tmux `%pause`, driver desync, a client error.

### 5.5 Attachments, size policy, backpressure

**Size policy (D-11)**

- Each attachment reports its *fitted viewport* (`cols × rows` computed by the fit addon) on attach and on change.
- An attachment becomes **active** when it sends `INPUT` or `terminal.activate` (focus or click on the pane).
- When the active attachment's viewport differs from the session size, the session resizes to it (debounced 100 ms).
- **Resize rule.** The server applies a resize to its emulator through the write queue (`term.write('', () => term.resize(c, r))`), so it lands in seq order, and then sends a fresh `SNAPSHOT` (carrying the new `cols`/`rows`) to every attachment. Clients never resize their own buffer independently; they only apply snapshots. `terminal.resized { channel, cols, rows, activeAttachment }` remains as an informational message for the UI (letterbox/scale; `activeAttachment` tells the receiving attachment whether it is the active one). Clients never see attachment ids.
- The order is driver-specific:
  - raw / tmux-normal: emulator resize (queued) + `setWindow` / `pty.resize` → `SNAPSHOT`.
  - tmux-control: `refresh-client -C` → `%layout-change` → the driver calls `ctx.resized()` → the runtime resizes the emulator (queued) → `SNAPSHOT` (§6.6).
- Passive attachments render the session size from the snapshot, scaled down to fit, or letterboxed when larger. They never resize the session until they become active.
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

Reconnect backoff: 1 s, 2 s, 4 s, 8 s … capped at 60 s, with ±20% jitter, retrying indefinitely while `desired_state = running`. An unknown host key pauses the loop in `awaiting_host_key` until the user decides; keyboard-interactive auth pauses it in `awaiting_user_input` until the user answers. Auth rejection or a host-key mismatch → `failed` (no automatic retry).

**`desired_state` transitions**

- User terminate → `desired_state = terminated` (then `terminating` → `ended`).
- A session that reaches `ended` (any reason) → `desired_state = terminated`. A `reopen` sets it back to `running`.
- A non-retryable `failed` keeps `desired_state = running`, but boot restore skips sessions whose last state is a non-retryable `failed` until the user retries (§5.8).
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

1. Open the DB; ensure an `installationId` exists.
2. Load the vault KEK; fail fast if it is missing or wrong (checked against a stored key-check value).
3. For every session with `desired_state = running`, except those whose last state is a non-retryable `failed` (they wait for the user's Retry), create a runtime and start it with concurrency 4 and per-host spacing (avoids SSH connection storms).
4. Mark the start in `session_events` (`restore_started` / `restored` / `restore_failed`).

**SIGTERM (graceful; the daemon's internal shutdown budget is 25 s, inside compose's `stop_grace_period: 30s`)**

1. Stop accepting attachments.
2. Notify clients (`server.shutting_down`) so they display "Restoring…" instead of an error.
3. For `tmux-control` sessions, detach the control client cleanly (send an empty line, wait for `%exit`) so the remote tmux keeps running.
4. Persist states and flush the batched writer (§9); close transports.

### 5.9 Host key verification

- Table `known_host_keys`: rows per host and key type, with `public_key_b64` and `status ∈ {trusted, pending, revoked}` (at most one `trusted` row per host and key type). session-manager writes every row (§9).
- **Fingerprint format.** Fingerprints are compared in OpenSSH format `SHA256:<unpadded base64>` (43 base64 characters). Pasted pre-trust fingerprints are normalized to that form (trimmed, `SHA256:` prefix added if missing, `=` padding removed) before storage or comparison.
- The ssh2 `hostVerifier(key, callback)` async form computes the fingerprint and the key type (parsed from the key blob).
  - **Trusted match** → continue.
  - **No trusted key for this host (unknown key)** → store the key as `status 'pending'` (with `public_key_b64`), **abort the connection**, and move the session to `awaiting_host_key`; broadcast `hostkey.prompt { sessionId, keyType, fingerprint, mismatch: false }`. The client answers `hostkey.decision { sessionId, fingerprint, accept }`. Accept → the daemon trusts exactly that pending key, matched by fingerprint (audit event), and reconnects. Reject → `failed`.
  - **On the reconnect**, a different key produces a new prompt if the host still has no trusted key, or a mismatch if a trusted key exists.
  - **Mismatch with a trusted key** → `failed` with code `HOST_KEY_MISMATCH`, a red alert, and an audit event. There is **no in-flow accept**. The owner must go to the host page and "Replace trusted key", typing the host name to confirm (`POST /internal/v1/hosts/:id/replace-key`); "Revoke" marks a trusted key `revoked` (`…/revoke-key`).
  - **Pending rows expire after 24 h.** A decision that arrives after its pending row expired trusts nothing; the next connect attempt prompts again.
- Pre-trust options on the host form: paste an expected fingerprint (normalized, then recorded as trusted via `trust-key`), or "Fetch & verify" (internal API `hosts/:id/test`), which records the presented key as `pending` and shows its fingerprint before any session exists; the user then trusts it via `trust-key`.
- Never `StrictHostKeyChecking=no`, in any code path, including tests (tests use pre-seeded keys).

### 5.10 Keyboard-interactive relay

- ssh2 runs with `tryKeyboard: true`. For connections that may prompt, ssh2's `readyTimeout` is set explicitly to **110 s**, so the handshake outlives the prompt timeout. On `keyboard-interactive` with prompts:
  - Exactly one prompt matching `/password/i`, with a stored password credential, on the first round → answer automatically (at most once per connection attempt, to avoid loops).
  - Otherwise → state `awaiting_user_input`; broadcast `auth.prompt { sessionId, promptId, name, instructions, prompts: [{ text, echo }] }` to all of that user's connections. The first `auth.response { sessionId, promptId, answers }` carrying the current `promptId` wins; answers with any other `promptId` are stale and discarded.
  - **Prompt timeout 100 s**, below OpenSSH's default `LoginGraceTime` of 120 s. On expiry the daemon closes the connection and the session stays in `awaiting_user_input` (not `failed`); the next connect attempt prompts again with a new `promptId`. That attempt starts only when someone can answer: an attachment opens the session, or the user presses Retry. There are no unattended prompt loops (repeated failed logins can trip fail2ban-style defenses on the host).
- Answers are never logged, persisted or echoed back. `echo: false` prompts are rendered as password inputs.

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

| Profile `protection_mode` | Probe result | Effective protection |
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
#   tmux_path=/usr/bin/tmux · utf8_locale=C.UTF-8 · scrollback_lines=10000 · profile env EDITOR=vim
# `exec /usr/bin/tmux` becomes `exec systemd-run --user --scope --quiet /usr/bin/tmux` only under the §5.11 logind rules.
export LC_CTYPE=C.UTF-8
exec /usr/bin/tmux -u -L td-1a2b3c4d-k3j9x2m8q0wz -f /dev/null -C \
  start-server \; \
  set-option -g history-limit 10000 \; \
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
- `history-limit` = the session's `scrollback_lines` (from the profile; never hard-coded).
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
| Terminate requested | `kill-server` on our socket, then close the transport. |

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

---

## 7. WebSocket protocol v1

One WebSocket per browser tab, multiplexing every attachment of that tab over numeric **channels**. Control messages are JSON text frames; terminal data uses binary frames. The protocol lives in `packages/protocol` (types + codec + tests) and is the shared contract between `web` and `session-manager`.

### 7.1 Connection and authentication

1. The browser calls `POST /api/ws/ticket` (cookie-authenticated; the response carries `Cache-Control: no-store`) → `{ ticket, expiresAt }`. The issuer refuses while the user has a pending TOTP enrollment or a pending forced password change (§10.2).
2. It opens `wss://<origin>/ws`. session-manager checks the `Origin` header against `TERMDOCK_PUBLIC_URL`; mismatch → close `4403`.
3. The first frame must be `hello` within 5 s: `{ "type": "hello", "protocol": 1, "ticket": "…" }`.
4. Ticket = `base64url(payload) "." base64url(HMAC-SHA256(TERMDOCK_WS_SECRET, payload))`, with payload `{ v: 1, uid, asid, exp, nonce }`, TTL 30 s, **single use** (nonce kept in an LRU until `exp`).
5. The server verifies that the auth session `asid` exists and is not expired (it reads the auth-session table) and that the user is not `banned`, binds the connection to `uid`, and replies `hello.ok`.
6. Revalidation (auth session still valid, user not `banned`) every 60 s, and immediately on `POST /internal/v1/auth-sessions/revoke`. A revoked connection is closed with `4401`.
7. **Sliding the auth session.** Terminal traffic goes over the WebSocket and never touches Next.js, so while a workspace is open the web client calls Better Auth's get-session every 10 min; that keeps the 7-day sliding expiry (§10.2) moving.

**Limits:** ws `maxPayload` is 1 MiB for client→server frames; at most 32 channels per connection; at most 50 running sessions per user (instance setting, enforced at session creation, §8.3).

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
| `ping` | `t` | app-level keepalive every 25 s |

Server → client:

| type | fields |
|---|---|
| `hello.ok` | `protocol, userId, serverTime` |
| `sessions.list` | full list of the user's sessions with `status`, `protection`, labels (sent after `hello.ok`) |
| `session.upsert` / `session.removed` | incremental list updates (also used for sessions created in another tab) |
| `session.status` | `sessionId, status, state, detail?, retryInMs?` |
| `session.attached` | `channel, sessionId, cols, rows, scrollbackLines` (followed by a `SNAPSHOT` frame; the browser sizes its scrollback from `scrollbackLines`) |
| `terminal.resized` | `channel, cols, rows, activeAttachment: boolean` (informational; the size itself is applied only from `SNAPSHOT` frames, §5.5) |
| `terminal.title` | `channel, title` (sanitized, ≤ 256 chars) |
| `terminal.bell` | `channel` |
| `hostkey.prompt` | `sessionId, keyType, fingerprint, mismatch` |
| `auth.prompt` | `sessionId, promptId, name, instructions, prompts: [{ text, echo }]` |
| `server.shutting_down` | `expectedBackInMs?` |
| `error` | `code, message, channel?, sessionId?` |
| `pong` | `t` |

Close codes: `4400` bad request · `4401` unauthenticated/revoked · `4403` forbidden/bad origin · `4409` protocol version unsupported · `4429` rate limited · `4500` internal.

Evolution: additive changes stay in v1 (receivers ignore unknown fields and unknown message types). Breaking changes bump `protocol`.

---

## 8. Control plane (web app)

### 8.1 Routes

| Route | Purpose |
|---|---|
| `/setup` | First-run only: create the first admin. Requires the one-time **setup token** printed in the web logs at boot while no user exists. Returns 404 afterwards. |
| `/login`, `/login/two-factor` | Username/password, then TOTP (with "trust this device for 30 days"). A pending forced password change (`must_change_password`) or required TOTP enrollment (`totp_required` or the instance-wide requirement) is completed before any other page opens. |
| `/workspace` | The terminal workspace (§11). Default landing page. |
| `/hosts`, `/hosts/[id]` | Hosts, with profiles managed inside the host detail. Host diagnostics (probe report, logind/linger warning, trusted and pending keys, "Fetch & verify", "Replace trusted key", "Revoke"). "Add this Docker host" preset (§13.4). Deleting a host or profile referenced by a non-ended session is rejected (§8.2). |
| `/credentials` | Create (password / paste private key / **generate ed25519 key** and show the public key), rename, delete (rejected while referenced by a non-ended session). Secrets are never displayed after creation. |
| `/activity` | The user's own session history and events. |
| `/settings/account` | Password, TOTP enroll/disable, language, theme. |
| `/settings/terminal` | Font, size, color scheme, cursor, clipboard (OSC 52) permission, link-opening confirmation. (Scrollback is per connection profile, §5.3.) |
| `/admin/users` | Create users (temporary password with a forced change on first login — `must_change_password`; role; require TOTP — `totp_required`), disable/enable (Better Auth admin plugin `banned`; disabling revokes the user's auth sessions and closes their WebSockets, while their terminal sessions keep running unless the admin ticks "also terminate sessions"), reset TOTP, revoke auth sessions. |
| `/admin/settings` | Instance settings: require TOTP for everyone, web idle timeout, maximum running sessions per user (default 50), local direct-mode visibility (only effective if the daemon flag is on). |
| `/admin/audit` | Audit log viewer with filters. |

### 8.2 Server API

- Mutations from forms use **Server Actions** (built-in origin check), validated with zod; every action re-checks ownership.
- Route handlers: `/api/auth/[...all]` (Better Auth), `POST /api/ws/ticket` (`Cache-Control: no-store`, §7.1), `/api/layout`, `/api/health`.
- **Layout API, optimistic concurrency.** `GET /api/layout` returns the layout and its `version`. `PUT /api/layout` carries `If-Match: <version>`; a mismatch → `409`, and the client reloads the stored layout and re-applies its change.
- Session creation, termination, retry and reopen: Server Action → internal API (§8.3). The UI receives the result via `session.upsert` on the WebSocket.
- **Deletes vs live sessions.** Deleting a host, profile or credential that is referenced by a non-ended session is rejected with `409 CONFLICT`; the user terminates those sessions first. Edits are always allowed: a session snapshots its target at creation (§9), so target edits affect only new sessions (policies are read live, §9).

### 8.3 Internal API (session-manager `:3002`)

Bearer `TERMDOCK_INTERNAL_TOKEN`, compared in constant time; a missing or wrong bearer → `401`. JSON; zod schemas in `packages/protocol/internal`. Every user-scoped call carries `actingUserId` (in the body, or in the query string for `GET`), and session-manager re-validates ownership against the DB. **Exceptions:** `POST /internal/v1/auth-sessions/revoke` (an admin/system action addressed by auth-session id or user id) and `GET /internal/v1/health`.

| Method & path | Body → Result |
|---|---|
| `POST /internal/v1/sessions` | `{ actingUserId, profileId, label?, viewport }` → `{ sessionId }`. Snapshots the target (§9). Rejected when the user already has the maximum number of running sessions (instance setting, default 50), and for `kind: local` when direct mode is off or the acting user is not an admin. |
| `POST /internal/v1/sessions/:id/terminate` | `{ actingUserId }` → `204` (`desired_state = terminated`) |
| `POST /internal/v1/sessions/:id/retry` | `{ actingUserId }` → `204`. Restarts the connect loop with the same `tmux_token` (reattaches the same tmux session); skips any remaining backoff wait ("Retry now"). |
| `POST /internal/v1/sessions/:id/reopen` | `{ actingUserId }` → `{ sessionId }`. New shell, same id, new runtime; `desired_state` back to `running`. Only for `ended` sessions or sessions with protection `none`; otherwise `409 CONFLICT`. |
| `GET /internal/v1/sessions?actingUserId=` | → live runtime statuses (authoritative) |
| `POST /internal/v1/credentials` | `{ actingUserId, name, kind: 'password', password }` · `{ actingUserId, name, kind: 'private_key', privateKey, passphrase? }` · `{ actingUserId, name, kind: 'generate', algorithm: 'ed25519' }` → `{ credentialId, publicKey, fingerprint }` (`publicKey`/`fingerprint` null for passwords) |
| `PATCH /internal/v1/credentials/:id` | `{ actingUserId, name }` → `204` (rename; the only mutable field) |
| `DELETE /internal/v1/credentials/:id` | `{ actingUserId }` → `204`; `409 CONFLICT` while referenced by a non-ended session |
| `POST /internal/v1/hosts/:id/test` | `{ actingUserId, profileId? }` → `{ reachable, hostKey: { type, fingerprint, trusted }, probe? }`. An unknown key is recorded as `pending`, so it can then be trusted with `trust-key`. |
| `POST /internal/v1/hosts/:id/trust-key` | `{ actingUserId, keyType, fingerprint }` → `204`. Trusts the pending key with that fingerprint; with no pending match, records a pasted pre-trust fingerprint (normalized, §5.9). |
| `POST /internal/v1/hosts/:id/replace-key` | `{ actingUserId, keyType, fingerprint, confirmHostName }` → `204`. After a mismatch: revokes the trusted key of that type and trusts the given fingerprint; `confirmHostName` must equal the host name. |
| `POST /internal/v1/hosts/:id/revoke-key` | `{ actingUserId, keyType }` → `204`. Marks the trusted key of that type `revoked`. |
| `POST /internal/v1/auth-sessions/revoke` | `{ authSessionId? , userId? }` → `204`; closes the matching WebSockets |
| `GET /internal/v1/health` | → `{ ok, sessions, uptimeMs, version }` |

### 8.4 i18n

`next-intl` with `en` (default) and `pt-BR`. Messages live in `apps/web/messages/{en,pt-BR}.json`, with keys `area.component.key`. Locale resolution: user preference (DB) → cookie → `Accept-Language` → `en`. No locale prefix in URLs. **CI fails if the two locale files have different key sets.** Server-generated banners written into terminals (§5.7) use the session owner's locale.

---

## 9. Data model (SQLite via Drizzle)

Conventions: `snake_case` tables and columns; UUIDv7 text ids; timestamps as integer epoch milliseconds; JSON as text with zod validation at the boundary; `PRAGMA journal_mode=WAL`, `foreign_keys=ON`. Migrations via `drizzle-kit generate` (never `push` outside local dev), applied by session-manager at boot; web waits for the schema version.

**Writers and lock waits.** SQLite serializes writers globally, and better-sqlite3 blocks the event loop while it waits for a lock. So:

- **session-manager** writes through an **async batched writer**: session events and state updates are queued and flushed in short transactions. Its own writes use `busy_timeout` **250 ms** plus retry, so a long web transaction never stalls the data plane.
- **web** keeps `busy_timeout` **5000 ms**.
- Retention purges (§10.2) run in chunks, never as one large delete.

**Auth tables (Better Auth, via the Drizzle adapter):** `user` (+ `username`, `role`, the admin plugin's `banned` / `ban_reason` / `ban_expires` — `banned` is how a user is disabled — `locale`, `totp_required`, `must_change_password`), `auth_session`, `account`, `verification`, `two_factor`. The final names come from Better Auth's schema generator; the session model is renamed to `auth_session`.

**Application tables**

```text
hosts                 id, user_id→user, name, kind('ssh'|'local'), hostname, port, tags_json,
                      created_at, updated_at

known_host_keys       id, host_id→hosts, key_type, public_key_b64 (null for a pasted pre-trust
                      until first match), fingerprint_sha256 ('SHA256:<43 chars>'),
                      status('trusted'|'pending'|'revoked'),       -- ≤ 1 trusted per host+key_type;
                      first_seen_at, decided_by→user, decided_at   -- pending expires 24 h after first_seen_at

credentials           id, user_id→user, name, kind('password'|'private_key'),
                      public_key, fingerprint_sha256,              -- keys only; public data
                      ciphertext, nonce, key_version,              -- AES-256-GCM of the JSON envelope (§10.2)
                      created_at, last_used_at

connection_profiles   id, user_id→user, host_id→hosts, credential_id→credentials (nullable),
                      name, username, protection_mode('auto'|'off'), startup_command,
                      term(default 'xterm-256color'), env_json, keepalive_interval_s(default 15),
                      auto_reopen(default 1), scrollback_lines(default 10000),
                      created_at, updated_at

sessions              id, user_id→user,
                      profile_id→connection_profiles (nullable, ON DELETE SET NULL; history survives),
                      target_kind('ssh'|'local'), target_host_id→hosts (nullable, ON DELETE SET NULL),
                      target_hostname, target_port, target_username,
                      target_credential_id→credentials (nullable, ON DELETE SET NULL),
                      term, scrollback_lines,                      -- copied from the profile at creation
                      label, desired_state('running'|'terminated'), state, status,
                      protection_effective('tmux-control'|'tmux-normal'|'none'),
                      tmux_token, tmux_version, remote_identity_json,  -- session_created, pane_pid
                      probe_json, cols, rows,
                      created_at, last_ready_at, ended_at, end_reason

session_events        id, session_id→sessions, type, detail_json, actor_user_id,
                      attachment_id, ip, user_agent, created_at

audit_events          id, actor_user_id, type, target_type, target_id, detail_json,
                      ip, user_agent, created_at

workspace_layouts     user_id (PK)→user, version, layout_json, updated_at

user_preferences      user_id (PK)→user, theme, terminal_json, updated_at

instance_settings     key (PK), value_json, updated_at            -- e.g. installation_id, vault_key_check,
                                                                  -- require_totp, max_running_sessions_per_user
```

**Live sessions vs edits and deletes.** A session snapshots its target at creation (`target_*`, plus `term` and `scrollback_lines`), so later edits to the profile's host, username or credential affect only new sessions. Launch settings (`startup_command`, `env_json`) only matter when the remote shell or tmux session is created; policies (`keepalive_interval_s`, `auto_reopen`, `protection_mode` for future reopens) are read live from the profile. Deleting a host, profile or credential referenced by a non-ended session is rejected (`409 CONFLICT`, §8.2). `desired_state` transitions are in §5.7.

**Write ownership** (per table). It prevents logical conflicts between the two processes; it does **not** avoid write contention, because SQLite serializes writers globally (see "Writers and lock waits" above).

| Writer | Tables |
|---|---|
| session-manager | `sessions`; `session_events`; all of `credentials` (rows created and deleted via the internal API, `last_used_at`); all of `known_host_keys` (pending, trust, replace, revoke via the internal API); `instance_settings` keys `installation_id` and `vault_key_check`; `audit_events` for host-key and credential events |
| web | auth tables; `hosts`; `connection_profiles`; `workspace_layouts`; `user_preferences`; every other `instance_settings` key; every other `audit_events` row |

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

- **Vault.** AES-256-GCM, 96-bit random nonce per record. The plaintext is a JSON envelope `{ v: 1, kind, password? | privateKey?, passphrase? }`. AAD = `credential_id ‖ user_id ‖ kind ‖ key_version` (ciphertext cannot be moved between rows, kinds or key versions). `key_version` supports rotation, and a key-check value in `instance_settings` (`vault_key_check`) detects a wrong KEK at boot. KEK = 32 random bytes from `TERMDOCK_MASTER_KEY_FILE` (Docker secret file, mode 0440, group 10001, §13.2). Private keys are validated with ssh2's key parser before storage. Generated keys are ed25519 in OpenSSH format. A `vault rotate` CLI re-encrypts all rows under a new key version (P8).
- **Web auth.** Better Auth: public sign-up disabled; users are created by admins with a temporary password and `must_change_password`, which forces a change at first login. Cookies `HttpOnly; Secure; SameSite=Strict`, 7-day sliding expiry (closing the browser does not log out, consistent with G1; the workspace keeps it sliding, §7.1). Login rate limit plus **account lockout per (username, IP) with progressive delay** — implemented by Termdock if Better Auth lacks it (S6). Client IPs come from Better Auth's `advanced.ipAddress` reading Caddy's `X-Forwarded-For` (§4.3). TOTP via the `twoFactor` plugin (trusted-device option); `totp_required` per user and an instance-wide requirement force enrollment at next login; admins can reset a user's TOTP. Disabled users are Better Auth admin-plugin `banned` users. The WS ticket issuer refuses while a TOTP enrollment or a password change is pending, and WS revalidation also checks `banned` (§7.1). Password hashing: argon2id if configurable in Better Auth (Node ≥ 24.7 `crypto.argon2`), otherwise Better Auth's scrypt default; decided in Phase 0.
- **CSRF and Origin.** Server Actions' origin check; route handlers verify `Origin`; WS Origin check.
- **Isolation (structural).** Every query is scoped by `user_id` through a **user-scoped repository layer** in both apps. A Biome `noRestrictedImports` rule forbids importing the `db` client directly outside that layer, so a missing scope is a lint error rather than something tests must catch. The T0 authorization tests (one case per resource type, WS attach, internal API) back this up.
- **Headers.** Nonce-based CSP (`script-src 'self' 'nonce-…'`; no eval; xterm.js needs none), `style-src 'self' 'unsafe-inline'` (the xterm DOM renderer injects style elements, so `style-src` carries no nonce), `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, HSTS (Caddy).
- **Terminal escape safety.** OSC 52 clipboard writes are disabled by default (per-user opt-in). Links (web-links addon / OSC 8) open only after a confirmation showing the full URL, with `noopener`. Titles are sanitized and length-capped. No OSC passthrough to the DOM.
- **Logging hygiene.** pino `redact` for passwords, keys, tickets, cookies and `auth.response` answers. Terminal input/output bytes are never logged. No terminal recording in MVP; when it comes, it is opt-in and encrypted (§18).
- **Audit.** `audit_events`: login success/failure and lockout, TOTP enable/disable/reset, user create/ban/unban, role change, credential create/delete, host-key pending/trust/replace/revoke/mismatch, local (direct-mode) session start, admin setting changes, auth-session revocation. `session_events`: created, attached, detached (with IP and user agent), connected, lost, reconnected, restored, degraded, ended. Retention configurable (default 180 days); purges run in chunks (§9).
- **Local direct mode.** Off unless `TERMDOCK_ENABLE_LOCAL_SHELL=true` on the daemon **and** enabled in admin settings. Admin-only (the internal API rejects `kind: local` for non-admins). Spawns shells as the daemon's OS user, which can read the master key and the DB, so enabling it gives admins effective access to the vault (§10.1). Recommended only outside containers, with a separate unprivileged UID for spawned shells (documented in the direct-mode guide). Every local session start is audited.
- **Containers.** Both images run as a fixed shared non-root UID/GID (`10001:10001`); read-only root filesystem with `tmpfs: /tmp` (writable data volume; web also gets a writable `.next/cache` volume); `cap_drop: [ALL]`, `no-new-privileges`, no Docker socket mounted (§13.1).
- **Supply chain.** T-14. pnpm `allowBuilds` blocks every dependency build script (§12): better-sqlite3 loads its bundled prebuilds and ssh2's optional native crypto is skipped. Any native module that would need a build step (e.g. node-pty for P6) is an explicit exception decided when it is added; runtime images carry no compilers. Next.js is kept at or above patched versions (the WS-upgrade SSRF advisory is not reachable because WS never goes through Next, but patch anyway).

---

## 11. UI/UX specification

### 11.0 Design process (`impeccable`, D-19)

The wireframes in this section define **information architecture and behaviour only**. All visual decisions (visual world, palette, typography, spacing, motion, component styling, terminal color schemes that harmonize with the app chrome) come out of the `impeccable` skill. Termdock's app surfaces use its **Operate** mode (scanability, consistency, real usage scene first; brand in the precise details). A future public landing page would be **Persuade**, and the docs site **Read**.

| When | `impeccable` step | Output |
|---|---|---|
| Phase 0, before any UI code | `init` | `PRODUCT.md`: users (developers/ops), usage scene (long-lived sessions, many hosts, phone on call), tone, constraints |
| Phase 0 | `shape` per core surface: workspace (desktop + mobile), auth (login / 2FA / setup), management (hosts / credentials / profiles), admin, settings | UX briefs reviewed by the owner before implementation |
| Phase 0 | new-work visual world | `DESIGN.md` + tokens (light/dark), terminal palettes, type scale |
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

- **Sidebar**: sessions grouped by host, each with its status chip (§5.6), a shield for protected sessions (tooltip: "Survives restarts and network drops"; a hollow shield for compatibility mode; none plus a tooltip for unprotected; the warning "remote may kill tmux on disconnect — enable linger" when the §5.11 logind rules give no reliable protection), and uptime. Context menu: rename, open in a new tab, split right/down, terminate (confirmation), reopen (only for ended or unprotected sessions, §5.7). "Ended" collapses the last 20.
- **New session**: command palette (`Ctrl/Cmd+K`) to search profiles. Also "New session" on a host's page.
- **Tabs and splits**: each tab holds a split tree (§9). Panes are resizable. **Closing a pane or tab only detaches.** The session keeps running in the sidebar. Terminating is always explicit.
- **Layout persistence**: saved to `/api/layout` (debounced 1 s; `PUT` with `If-Match: <version>`; on `409` the client reloads and re-applies, §8.2). Opening Termdock in any browser restores tabs, splits and the attached sessions, with snapshots (fidelity per §5.3.1). Panes bound to ended sessions show "Session ended — Reopen".
- **Overlays inside the pane**: "Connecting…" / "Restoring…" (a subtle spinner over the last known screen, never a blank terminal); Action required (host key with the fingerprint, keyboard-interactive prompts); Reconnecting (countdown + "Retry now", which skips the backoff wait); Disconnected (reason + Retry). Both buttons call the retry endpoint (§8.3).
- **Keyboard**: when a terminal has focus, every key goes to the terminal. App shortcuts use `Ctrl+Shift+<key>` (configurable): new session, next/previous tab, split, close pane, command palette.
- **Terminal features**: fit, WebGL renderer (fallback to DOM), unicode11, search (`Ctrl+Shift+F`), web links (with confirmation), copy-on-select option, right-click paste option, font size zoom, color schemes (bundled presets), bundled JetBrains Mono (OFL) with a system-font option.

### 11.2 Mobile (< 768 px)

- The sidebar becomes a drawer; tabs become a dropdown. The **split structure is shown one pane at a time** (pane switcher), and mobile **never mutates** the split tree, so the desktop layout is preserved.
- **Extra-key bar** above the soft keyboard: `Esc`, `Tab`, `Ctrl` (sticky), `Alt` (sticky), `←↑↓→`, `Home`, `End`, `PgUp`, `PgDn`, `|`, `~`, `/`, `-`, paste, hide keyboard. Ctrl+letter maps to `byte & 0x1f`.
- Touch scrolling of scrollback; pinch or buttons for font size.
- Typing on the phone makes it the active attachment, so the session resizes to the phone (D-11). The desktop then shows it letterboxed until it is used again. A per-attachment "lock size" toggle is on the roadmap.

### 11.3 Accessibility and polish

Light and dark themes; xterm.js screen-reader mode toggle; visible focus; all non-terminal pages keyboard-navigable; reduced-motion respected.

---

## 12. Repository layout and conventions

```text
termdock/
├── apps/
│   ├── web/                       Next.js 16 — UI + control plane
│   │   ├── app/                   routes (§8.1)
│   │   ├── components/            ui/ (shadcn), terminal/, workspace/, mobile/
│   │   ├── lib/                   auth, repositories (user-scoped db access), internal-api client, ws client
│   │   └── messages/              en.json, pt-BR.json
│   └── session-manager/
│       └── src/
│           ├── main.ts            boot, restore, signals (run directly: `node src/main.ts`)
│           ├── config/            env parsing (zod)
│           ├── core/              types.ts (canonical interfaces), SessionRuntime (SessionHost), registry, state machine
│           ├── repositories/      user-scoped db access
│           ├── transport/         ssh/ (ssh2), local/ (child_process + node-pty)
│           ├── drivers/           raw-pty/, tmux-control/ (parser, correlator, input, snapshot), tmux-normal/
│           ├── probe/
│           ├── emulator/          headless wrapper, serialize, rebuild-from-capture
│           ├── attachments/       size policy, coalescing, backpressure
│           ├── ws/                server, tickets, protocol handlers
│           ├── internal-api/
│           ├── vault/             vault + CredentialProvider
│           └── events/            batched DB writer (session events, state updates)
├── packages/
│   ├── protocol/                  WS v1 + internal API + layout schemas (zod), binary codec, toSessionStatus
│   ├── db/                        Drizzle schema, migrations, client factory, pragmas
│   ├── terminal-config/           pinned xterm options, unicode provider, query silencer, mode tracker
│   └── shared/                    ids (UUIDv7), errors/codes, logger factory, time
├── scripts/                       test-area.ts (T1 runner); dev-session.ts (dev-only CLI, P1; never shipped in images)
├── deploy/
│   ├── compose.yaml
│   ├── Caddyfile
│   ├── docker/                    web.Dockerfile, session-manager.Dockerfile
│   └── scripts/                   init-secrets.sh, backup.sh, restore.sh
├── test/
│   ├── sshd/                      Dockerfiles (D-22): alpine:3 no-tmux, ubuntu:22.04 3.2a, ubuntu:24.04 3.4, alpine:edge newest; KI/OTP variant
│   ├── integration/               session-manager ↔ real sshd
│   └── e2e/                       Playwright
└── docs/
    ├── implementation-plan.md     (this file)
    ├── adr/                       ADR-0001… (spike outcomes and design decisions)
    └── guides/                    install, configuration, security-model, direct-mode, docker-host
```

**Conventions**

- **Language: English** for code, identifiers, comments, docs, commit messages and UI default copy (D-18).
- TypeScript **6.0.3** (pinned: TS 7 rewrote the compiler and its Next.js/tooling compatibility is unverified), `strict`, ESM only.
- Lint and format with **Biome** (a single dependency; `biome.json` at the root). The isolation rule (`noRestrictedImports` for direct `db` imports, §10.2) lives there.
- session-manager runs TypeScript directly with Node 24 type stripping (`node src/main.ts`), so its code uses erasable syntax only. There is no build step and no tsx.
- pnpm **11.13.0** (the `packageManager` field) with workspaces and `workspace:*` internal deps; exact external versions; `engines` set; `.nvmrc` = 24. pnpm `allowBuilds` blocks every dependency build script: better-sqlite3 loads its bundled prebuilds, and ssh2's optional native crypto is skipped.
- Root scripts: `pnpm check` (typecheck + lint + T0), `pnpm test:area <terminal|ssh|tmux>` (T1), `pnpm format`.
- Commits (D-20): one or more commits per delivered functional block, made by the orchestrator after verification. Messages are short and imperative, at most 2 lines, with no co-author or attribution trailers. Local only until a remote exists (no push).
- Every architectural change or spike outcome gets an ADR in `docs/adr/`.

---

## 13. Deployment and operations

### 13.1 Docker Compose

```yaml
# deploy/compose.yaml (shape; finalized in P8)
services:
  caddy:
    image: caddy:2            # exact digest pinned in P8 (base image approved then, D-22)
    ports: ["80:80", "443:443"]
    environment: [TERMDOCK_DOMAIN]
    volumes: [./Caddyfile:/etc/caddy/Caddyfile:ro, caddy-data:/data]
    networks: [edge]          # never on `internal`
    depends_on: [web, session-manager]
  web:
    build: { context: .., dockerfile: deploy/docker/web.Dockerfile }
    user: "10001:10001"
    environment: [TERMDOCK_PUBLIC_URL, TERMDOCK_INTERNAL_URL=http://session-manager:3002]
    secrets: [auth_secret, internal_token, ws_secret]
    volumes: [termdock-data:/data, web-next-cache:/app/apps/web/.next/cache]
    networks: [edge, internal]
    read_only: true
    tmpfs: [/tmp]
  session-manager:
    build: { context: .., dockerfile: deploy/docker/session-manager.Dockerfile }
    user: "10001:10001"
    environment: [TERMDOCK_PUBLIC_URL, TERMDOCK_ENABLE_LOCAL_SHELL=false]
    secrets: [master_key, internal_token, ws_secret]
    volumes: [termdock-data:/data]
    networks: [edge, internal]
    extra_hosts: ["host.docker.internal:host-gateway"]
    stop_grace_period: 30s    # the daemon's own shutdown budget is 25 s (§5.8)
    restart: unless-stopped
    read_only: true
    tmpfs: [/tmp]
networks: { edge: {}, internal: {} }
volumes: { termdock-data: {}, caddy-data: {}, web-next-cache: {} }
secrets:                      # bind mounts outside swarm: uid/gid/mode come from the files themselves
  master_key:     { file: ./secrets/master_key }
  internal_token: { file: ./secrets/internal_token }
  ws_secret:      { file: ./secrets/ws_secret }
  auth_secret:    { file: ./secrets/auth_secret }
```

`Caddyfile`: `{$TERMDOCK_DOMAIN}` with `reverse_proxy /ws session-manager:3001` and `reverse_proxy web:3000`. For local testing, `tls internal`. Caddy sets `X-Forwarded-For` and is the only trusted proxy (§4.3).

Compose `secrets:` with `file:` are bind mounts outside swarm (the `uid`/`gid`/`mode` keys are honored only in swarm), so the containers see the files' own ownership and mode; `init-secrets.sh` sets them (§13.2).

### 13.2 Configuration (environment)

| Variable | Component | Notes |
|---|---|---|
| `TERMDOCK_DOMAIN` | caddy | site address in the `Caddyfile` (`{$TERMDOCK_DOMAIN}`), e.g. `termdock.example.com` |
| `TERMDOCK_PUBLIC_URL` | both | e.g. `https://termdock.example.com`; used for the Origin check and cookies |
| `TERMDOCK_DATA_DIR` | both | default `/data` (SQLite at `/data/app.db`) |
| `TERMDOCK_MASTER_KEY_FILE` | session-manager | vault KEK (32 bytes, base64) |
| `TERMDOCK_INTERNAL_TOKEN_FILE` | both | internal API bearer |
| `TERMDOCK_WS_SECRET_FILE` | both | WS ticket HMAC key |
| `BETTER_AUTH_SECRET_FILE` | web | auth signing secret |
| `TERMDOCK_INTERNAL_URL` | web | `http://session-manager:3002` |
| `TERMDOCK_ENABLE_LOCAL_SHELL` | session-manager | default `false` |
| `TERMDOCK_LOG_LEVEL` | both | default `info` |

`deploy/scripts/init-secrets.sh` generates every secret with `openssl rand` into `./secrets/` (gitignored), sets mode 0440 and group 10001 (the images' shared GID) on each file, and warns: **back up `master_key`. Losing it means losing every stored credential.**

### 13.3 Running outside the container (direct-mode testing, D-15b)

`docs/guides/direct-mode.md` documents running `session-manager` manually on a host:

1. Prerequisites: Node 24, pnpm, and build tools in case node-pty has no prebuild for the platform.
2. `pnpm install`. There is no build step: session-manager runs with `node src/main.ts` (Node 24 type stripping).
3. Env file pointing at a local data dir and secrets; `TERMDOCK_ENABLE_LOCAL_SHELL=true`. Recommended: spawned shells run under a separate unprivileged UID (§10.1).
4. Run `web` either via compose (with the data dir bind-mounted and the internal URL pointing at the host; sharing the SQLite WAL this way is safe only on a Linux host, §9) or with `pnpm --filter web dev`.
5. Enable direct mode in admin settings; create a host of kind `local`.

Local sessions use `LocalTransport`: node-pty for raw mode, and `child_process.spawn('tmux', ['-u','-L',…,'-C',…])` for `tmux-control` when local tmux ≥ 3.2 is present. The same drivers run over a different transport, so protected local sessions can survive daemon restarts too — **but only when the tmux server lives outside the daemon's cgroup**: not inside the container, and under systemd either `KillMode=process` on the daemon's unit or tmux launched via `systemd-run --user --scope`.

### 13.4 "This Docker host" preset (D-15a)

On `/hosts`, "Add this Docker host" creates a host `host.docker.internal:22`, generates an ed25519 credential, and shows the exact `authorized_keys` line, plus a copy-paste command, for the host user. The first connect goes through the normal host-key trust flow.

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
| `[T2]` | Belongs to the **pre-release** battery (routine to be defined) |
| `[once]` | Verified once at delivery (scripted or manual); the result goes in the delivery report and commit description. No permanent test. |

### Phase 0 — Foundations, spikes, canonical contracts

**Scope**

- Monorepo scaffold (pnpm 11.13.0, TypeScript 6.0.3, Biome, Vitest), CI (GitHub Actions: typecheck, lint, unit, i18n parity, build; integration job with the sshd matrix).
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
- **E.** `[once]` `PRODUCT.md` and `DESIGN.md` exist; the owner has approved the workspace and auth `shape` briefs.

### Phase 1 — Data plane core (unprotected path), vault, internal API

**Scope**: `SshTransport` (ssh2: keepalive 15 s × 3, password/key auth through `CredentialProvider`, host-key verification against seeded keys), `RawPtyDriver`, emulator wrapper (mode tracker, `snapshot()`), `SessionRuntime` (`SessionHost`) and registry, state machine, WS server with protocol v1 and **real ticket validation** (`verifyTicket` + nonce cache from `packages/protocol`, Origin check, auth-session and `banned` revalidation; in P1 tickets are minted by the dev CLI with the shared secret), attachments with size policy, resize-by-snapshot, the snapshot cache, coalescing and backpressure, the batched DB writer. **Vault** (envelope encryption, the vault-backed `CredentialProvider`) and the **internal API** with bearer auth: credentials create/delete; sessions create/terminate/retry/reopen/list (the host-key routes come in P4). **Dev CLI** `scripts/dev-session.ts`: seeds a user, host, profile and credential directly in the DB and creates and attaches sessions (dev only; never shipped in images). A minimal dev page for attaching.

**Exit criteria**

- **A.** `[T0]` Unit tests for the intricate pure logic only: state machine and `toSessionStatus`, seq/snapshot-barrier bookkeeping, size policy.
- **B.** `[T1]` Integration (no-tmux sshd): open a session, run `vim /etc/hosts`, close the WS, reattach → the attached client's SerializeAddon `serialize()` output equals the server emulator's (text + attributes + cursor + alt-screen flag), **and** a mode/state probe matches (mouse encoding, cursor style, alt screen).
- **C.** `[once]` `[T2]` Two attachments: input from either reaches the shell; activating one resizes the session; every attachment receives a fresh `SNAPSHOT` carrying the new size, plus `terminal.resized`.
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
- **E.** `[T2]` Vulnerability scan (OSV via `ats-dependency-security` batch mode) shows no known High/Critical vulnerabilities.
- **F.** `[once]` `impeccable` release passes (`harden`, `clarify`, `adapt`, `polish`) done; docs reviewed.
- **G.** `[once]` The owner has defined the pre-release routine (§15.4) and it has been run once end to end.
- **H.** `[T2]` CSP check: no CSP violations are reported during the E2E signature flow (P5 A).

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
| **T2 — Pre-release** | Before tagging a release | `pnpm test:release` (planned) + a manual checklist | Full tmux matrix (the three D-22 versions), the few E2E flows, chaos/lifecycle, soak, deployment, security and vulnerability scans. **Exact routine to be defined with the owner (§15.4).** |

T1 is the middle tier between "always" (T0) and "pre-release" (T2), the two sets D-21 names; it is to be confirmed by the owner together with the release routine (§15.4).

### 15.3 Test map

The T1 cells name the `pnpm test:area` area that runs them.

| Area | T0 — Always | T1 — When the area changes | T2 — Pre-release | Deliberately not automated |
|---|---|---|---|---|
| WS protocol | codec round trip (all frames/messages) | — | — | — |
| tmux control protocol | parser replaying recorded fixtures: framing, octal unescape, `%extended-output`, FIFO correlation, guard spoofing | `tmux`: restore after daemon restart; `exit` ends the session (3.2a + newest packaged) | full matrix (three versions); network drop; flood/flow control; graceful stop; normal-mode fallback (P7, once its image is approved) | nested-tmux and no-tmux notices (checked once) |
| Emulator / snapshots | seq + snapshot-barrier bookkeeping; query-silencer coverage; `@xterm/xterm` = `@xterm/headless` version pin | `terminal`: small golden set — snapshot applied to a client vs the server (SerializeAddon output + mode/state probe); capture-rebuild vs live (vim alt screen, wrapped lines, colors, CJK) | large-output (`cat` 200 MiB) | exhaustive escape-sequence coverage (xterm.js's job) |
| Session runtime | state machine + `toSessionStatus`; backoff (fake timers); size policy | — (raw-mode reattach runs under `ssh`) | multi-attach and slow-reader behaviour | — |
| SSH | host-key decision logic + fingerprint normalization | `ssh`: raw-mode reattach on the no-tmux sshd (`serialize()` equality + mode/state probe) | keyboard-interactive/OTP flow | ssh2 internals |
| Security | authorization isolation (one case per resource type + WS attach + internal API); repository-layer import rule (lint); vault (envelope round trip, AAD, wrong key); WS tickets/Origin (incl. refusal while enrollment is pending, `banned`); internal-API bearer rejection (401, constant-time compare); local-mode gating (flag off; non-admin) | — | security review; OSV scan; CSP check | — |
| Auth (web) | — | — | setup token, login + TOTP + forced password change + lockout (E2E) | Better Auth internals |
| Workspace UI | i18n key parity | — | **signature flow (E2E)**: tabs/splits → close browser → reopen → identical layout and content; daemon restart → restored; manual real-phone check | visual/snapshot tests, styling, CRUD form plumbing (covered by `impeccable` audit rounds instead) |
| Deployment / ops | — | — | clean `compose up` smoke; backup → restore; 24 h soak | — |

### 15.4 Pre-release routine (to be defined)

The owner will define the release routine. The T2 column above is the **candidate** content. Proposed shape for that discussion:

1. Automated: `pnpm test:release` (full matrix, E2E signature flows, chaos, deployment smoke, OSV scan).
2. Long-running: the 24 h soak (can run in parallel with manual checks).
3. Manual checklist (`docs/release-checklist.md`, created when the routine is agreed): real phone, both locales, host-key mismatch UX, KI/OTP host, direct mode outside the container.
4. Security review for releases that touch auth, the vault, WS or the internal API.

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
5. No push until a remote exists.

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
| Emulator memory: ~12 bytes per cell (10k lines × 120 cols ≈ 14 MiB per session) | High RSS with many sessions | Default 10k lines, configurable per profile; documented budget; soak test; roadmap: compress idle scrollback |
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
- Per-attachment "lock size" and "follow" modes; notifications (bell/activity/command finished); SFTP/file transfer; a CLI client attaching over the same protocol; emulator memory compaction for idle sessions.

---

## 19. Open items (non-blocking; defaults apply until the owner decides)

| Item | Default until decided |
|---|---|
| License for a possible open-source release (MIT, Apache-2.0, AGPL-3.0) | Decide before the repository goes public (P8). Recommendation: Apache-2.0 (patent grant) or AGPL-3.0 if hosted forks should share changes. |
| Default scrollback size | 10,000 lines (memory trade-off, §17) |
| Default `auto_reopen` for unprotected sessions | On, with banner |
| Web auth-session lifetime | 7 days sliding; admin-configurable idle timeout |
| Public repository/organization name | Not decided |
| Pre-release test routine (§15.4) | Candidate content = the T2 column of §15.3; to be defined with the owner before the first release, together with confirming the T1 tier (§15.2) |
| Test image with tmux < 3.2 (Phase 7) | None approved (D-22); the normal-mode fallback stays untested until the owner approves one when P7 starts |

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
