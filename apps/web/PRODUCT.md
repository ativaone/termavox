# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Decided by the owner and the implementation plan (`docs/implementation-plan.md`): Next.js 16 (App Router) + React 19 for the web control plane, xterm.js 6 for terminals, Tailwind 4, `next-intl` (English default, pt-BR), Better Auth. A separate Node.js daemon (`apps/session-manager`) holds the sessions. The visual layer (tokens, typography, component styling) is `DESIGN.md` (plan D-26).

## Users

Open-source, self-hosted from day one. The primary users are developers and operators who keep shells open on several servers for long stretches (deploys, debugging, database consoles, log tails). They install Termdock on a bastion or on one of their own servers and reach it from a laptop browser and, during on-call moments, from a phone. Each installation has an admin who creates the user accounts; every user sees only their own servers, credentials and sessions.

## Product Purpose

Termdock is a persistent terminal-session runtime accessible from the web. It holds SSH (and local) sessions open on the server side until the user explicitly ends them. Browsers only attach and detach. Success means a user can close the laptop, lose Wi-Fi, or switch to a phone, and on return find every terminal exactly where it was: same screen, cursor, colors, scrollback, with `vim` or `htop` still running. Recovery after a service restart or a network drop should go unnoticed (a brief "Restoring…" at most).

## Positioning

The browser lifecycle is not the terminal lifecycle. Unlike web SSH gateways that tie the SSH connection to the browser tab, Termdock keeps an authoritative terminal emulator on the server and treats the browser as a synchronized view. tmux is used automatically and invisibly underneath (control mode) as a second layer of persistence, so the user never sees or operates tmux to get its benefits.

## Operating Context

- Long-lived sessions: hours to weeks, many servers at once, often several sessions per server.
- Typical work inside sessions: shells, editors (`vim`), monitors (`htop`), pagers (`less`), `kubectl`, database consoles, log tails.
- Reached from desktop browsers with tabs and split panes, and from phones with an extra-key bar (Esc, Ctrl, Alt, Tab, arrows).
- It is a privileged bastion: host-key trust decisions, two-factor login and session status must be clear and trustworthy at a glance.
- Sessions carry user-facing statuses: Connecting…, Restoring…, Connected, Action required, Reconnecting…, Disconnected, Ended. A session is either protected (survives restarts and network drops) or not, and the UI says which.

## Capabilities and Constraints

- Servers (plan D-29): one record per `ssh user@host` target, holding the name, address, port, user name, the credential (or none: the server asks in the terminal) and the session options; the same machine as another user is another server. Credentials (password or private key, stored encrypted) are separate and reusable across servers. Sessions are terminals opened from a server (a server can have many), and attachments are the browsers viewing a session (several can attach to the same session; the most recently active one drives the terminal size). Host-key trust is per user and per address.
- Workspace: a session sidebar, tabs and split panes. The layout is stored on the server per user and restored in any browser. Closing a pane only detaches; terminating a session is always explicit, one at a time or with "End all sessions". Ending a session also ends its tmux on the server, at the next connection there if the server cannot be reached now; a server's page lists the Termdock sessions left running there that this installation does not run (another installation, or this one before a database reset), to adopt or end (plan D-30).
- Files (plan D-39): a session's pane can open a file panel beside its terminal that browses the session's server as the session's user, over that session's own SSH connection (SFTP): upload and download several files at once, rename, delete, new folder. Nothing is installed on the server; an admin can turn the panel off and record file operations in the audit log.
- Login with username + password and optional TOTP (an admin can require it). Admin pages: users, instance settings, audit log.
- UI language: English by default, pt-BR selectable; both ship in the first release. All strings are externalized.
- Terminal rendering inside panes is xterm.js; the app chrome around it is ours to design.
- License: AGPL-3.0-only (plan D-24). Undecided: the public repository/organization name.

## Brand Commitments

The name is Termdock. No other binding brand assets, colors, typography or references exist; the visual identity comes from the design pass.

## Evidence on Hand

None yet: greenfield project with no users, screenshots, testimonials, benchmarks or press. Future work must not fabricate any of these.

## Product Principles

1. Continuity is the product: never show a blank terminal where state exists; recovery is quiet and fast.
2. Honest status: protection, connection state and trust decisions are always visible and never overstated.
3. The terminal comes first: when a terminal has focus, every key belongs to it; the app chrome stays out of the way.
4. Safe by default for a privileged tool: explicit host-key trust, explicit termination, no surprising side effects on remote servers.
5. Works where operators actually are: a desktop with many panes, and a phone during an incident.
