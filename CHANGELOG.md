# Changelog

All notable changes to Termavox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

The first release, v0.1.0: the first supported release, internally reviewed twice, not
externally audited. Read the [security model](docs/security.md) before you expose it.

### Upgrade notes

A new install needs nothing here. A development build of `main` from before v0.1.0 cannot be
upgraded: remove it together with its volumes and install fresh from a new clone, as the
[installation guide](docs/guides/install.md) describes.

### Added

- Published images: each release puts three images on GitHub's container registry, for
  `linux/amd64`, with `linux/arm64` coming soon (`ghcr.io/ativaone/termavox-caddy`, `-web` and
  `-session-manager`), tagged with the version and built, tested and published by the release
  workflow; installs no longer need to build anything. `deploy/compose.yaml` names them and keeps
  its build sections for installs from source.
- A project site at https://ativaone.github.io/termavox, in English and Brazilian Portuguese: a
  home page with screenshots, and a documentation area with the installation guide, the
  configuration reference, the architecture, the security model and this changelog, rendered
  from the repository's docs at every change. Every page carries search and link-preview
  metadata, and the site publishes a sitemap.
- Help in the app: a help button beside the account menu opens the documentation, and its user
  guide explains what happens to a session in each situation (closed browser, network drops,
  restarts, a server reboot, tmux killed on the server), every status and message, and what to
  do. "Learn more" links in the reconnecting, disconnected and ended panels, the server-restarted
  notice, the tmux tip, host-key prompts, the file panel and the server page open it at the right
  section. The account menu links to the source code on GitHub.
- The running version, at the foot of the account menu for signed-in users and logged once by
  web and session-manager at startup; the user help says to include it when reporting a problem.
- A Files panel inside a session's pane, beside its terminal: browse the server as the session's
  user, upload and download several files at once with progress bars, rename, delete, create
  folders, show hidden files and refresh. It uses the session's own SSH connection (SFTP), so it
  works wherever the terminal does, and opens at the terminal's folder in protected sessions. In
  a split each pane has its own; on a phone it takes the whole screen. When a server offers no
  SFTP the panel says what to enable there. Admin settings can turn file transfer off and record
  file operations in the audit log (off by default).
- `deploy/scripts/reset-password.sh <username>` sets a temporary password from the host when no
  admin can sign in, for example when the only admin forgot their password. The user must choose
  a new password at the next sign-in. `--reset-totp` also resets TOTP, for a lost authenticator
  whose backup codes are gone too. The audit log now labels every reset "Password reset" or
  "Two-step reset", and its actor column says who did it.
- Running behind your own reverse proxy (nginx, Traefik…) that terminates TLS: `TERMAVOX_TLS=off`
  serves plain HTTP, `TERMAVOX_BIND_ADDRESS` keeps the port on loopback, and
  `TERMAVOX_REVERSE_PROXY` names the proxy so each user's own address is still seen. The install
  guide has a section for it, with an nginx example.
- A tip in the pane when you start tmux inside a protected session: Termavox already keeps the
  session running, and without a tmux inside it scrolling, selection and copy work in the
  browser. "Don't show again" turns it off; terminal settings turn it back on.
- Persistent SSH sessions owned by the server: closing the browser, losing the network or
  restarting the web app never ends a terminal. Browsers attach to an authoritative server-side
  emulator and get an exact snapshot followed by the live stream.
- Automatic, invisible tmux protection through tmux control mode (tmux ≥ 3.2), with
  auto-detection and a graceful unprotected fallback. Protected sessions survive daemon
  restarts and network drops ("Restoring…").
- Workspace with a collapsible session list, tabs and split panes; the layout is saved on the
  server and restored in any browser. Several browsers can attach to one session at once.
- Session names: give a session a name when you open it and rename it later from its menu or by
  double-clicking its tab; every attached browser sees the new name.
- Servers: one entry holds the address, the user name, the credential and the connection
  options (tmux protection, startup command, environment, keepalive, scrollback, auto-reopen),
  like an `ssh user@host` command line. Duplicate copies a server to change its user or key.
  Credentials are stored on their own and reused across servers.
- "Add server" sets up a server and its credential on one page (generate a key, paste one, a
  password, a saved credential or none), then shows the public key with the command that
  installs it and starts a session in one click.
- Phone support: responsive layout and an extra-key bar (Esc, Tab, Ctrl, Alt, arrows, paste).
- The Termavox mark as the browser icon, and a web app manifest, so a pinned tab, a taskbar
  shortcut or an installed app shows it too.
- Multi-user with strict per-user isolation of servers, credentials, host keys and sessions.
- SSH authentication with private keys (with passphrase), passwords and keyboard-interactive
  prompts (OTP/2FA) relayed to the browser.
- Host-key trust on first use with an explicit decision, hard failure on mismatch, and server
  diagnostics to test, replace or revoke keys. Decisions are kept per address, like
  `known_hosts`, so they cover every server you add for the same address.
- Web sign-in with username and password plus optional TOTP (admins can require it), backup
  codes, rate limits and lockout.
- Administration: users, roles, instance settings and an audit log; per-user activity history.
- English and Brazilian Portuguese UI.
- Docker Compose deployment behind Caddy (automatic HTTPS), hardened containers, backup and
  restore scripts.
- Master key rotation, all or nothing and after a backup: `deploy/scripts/rotate-master-key.sh`.
- Audit and session-event retention: rows older than `TERMAVOX_EVENT_RETENTION_DAYS` (default
  180, `0` keeps them forever) are purged in small chunks every 6 hours.
- Ending a session reaches its server: when the session is not connected, Termavox connects
  just to end its tmux there. If it cannot, the session ends anyway, its pane says so, and the
  next connection to that server ends the leftover.
- Leftover sessions are found: when a session connects, Termavox looks for Termavox tmux
  sessions on that server it does not run (another installation, or this one before a database
  reset) and points to them from the workspace. The server's page lists them under "Sessions on
  this server" with Adopt (open it as a session of that server) and End. Leftovers of sessions
  you already ended are ended right away.
- "End all sessions" in the workspace, a first step before any database reset in the upgrade
  guide, and a log line at shutdown saying how many sessions keep running on their servers.
- Bounded connection retries with a Stop button: a session that never connected tries 4 times
  in about a minute; one that lost its connection keeps trying for 30 minutes. Then it waits for
  Retry. Until it first connects, a session uses its server's current address, so a mistyped
  server can be fixed on its page and retried.
- Ended sessions can be removed from the list, one by one or all at once, with their history.
- Image paste: an image pasted into a terminal (with no text in the clipboard) is sent to the
  session's server, into `~/.cache/termavox/paste`, and its path is pasted, so a program there
  (Claude Code, for one) can open it. It uses the file panel's transfer; pastes older than 7 days
  are removed from that folder when a new one is saved.
- Adjustable widths: drag the line between the session list and the workspace to resize the
  list, and the terminal area's left or right edge to narrow it without a split (double-click an
  edge to put it back). The widths apply to every tab and are kept per browser.
- Terminal type for protected sessions, under Advanced on a server's page: Automatic (the
  default, tmux's own type, as tmux recommends) or xterm-256color, which makes programs act as in
  a plain terminal (Ctrl+End in vim, for example) at the risk of an imperfect screen after a
  restart. It applies to new sessions. Protected sessions now also set `COLORTERM=truecolor`, so
  programs use 24-bit color, unless the server's environment variables set COLORTERM.

### Fixed

- Home and End in protected sessions: programs inside the session's tmux now get them as their
  terminal reads them. Before, vim in insert mode took End for a new line with an "F" in it, and
  Home for one with an "H".

### Security

- Caddy runs as a non-root user (UID/GID 10002, apart from web and session-manager's 10001) with
  every capability dropped. Its binary no longer carries the `cap_net_bind_service` file
  capability; it binds ports 80 and 443 (TCP and UDP) through its own container's
  `net.ipv4.ip_unprivileged_port_start=0` sysctl. The Caddyfile is baked into its image.
- Release images carry a signed build provenance attestation: `gh attestation verify
  oci://ghcr.io/ativaone/termavox-web:<version> --repo ativaone/termavox`.
- Vulnerabilities are reported privately through GitHub (`SECURITY.md`); only the latest release
  is supported.

Hardening from the internal pre-release security review:

- A host key the owner revoked now fails closed like any mismatch; it can only be trusted again
  through the explicit replace flow.
- SSH targets on loopback, link-local, multicast or the daemon's own addresses are refused by
  default (`TERMAVOX_SSH_ALLOW_LOCAL_TARGETS=true` allows them); host tests are rate-limited.
- Resource caps: idle runtimes of stopped sessions are evicted, WebSocket connections and
  attachments are capped per user, in-flight messages are bounded per connection, and the
  Compose services have memory and process limits.
- Capability-probe output from the host is bounded.
- Profile values the launch cannot pass safely are rejected by the form and park the session
  instead of reconnecting in a loop.
- Terminal hyperlinks (OSC 8) go through the same confirmation and scheme filter as other links.
- Keyboard-interactive prompts always carry Termavox's own framing; host text is capped and
  stripped of control and invisible formatting characters, as are terminal titles.
- WebSockets close right away after a password change, sign-out or TOTP reset.
- SHA-1 `ssh-rsa` host-key signatures are no longer offered.
- Client IPs use the rightmost untrusted `X-Forwarded-For` value; log redaction covers
  environment values, tokens and cookies; `Permissions-Policy` and
  `Cross-Origin-Opener-Policy` headers are sent.

From the second internal review (2026-10-19):

- Sign-in is limited to 10 attempts per minute per client address, on top of the per-username
  lockout. Better Auth's own limiter never applied to the sign-in form. A lockout can no longer
  be cleared early by flooding failures for other usernames.
- `/api/auth/*` serves only the workspace's session keep-alive. Better Auth's other endpoints,
  which the app never used, answer 404: an anonymous check of which usernames exist, users
  editing the display name admins see, and raw admin endpoints that skipped Termavox's own
  checks and audit log.
- Pasting into a terminal removes control characters first, so clipboard text cannot end a
  bracketed paste early and run commands as if typed.
- The link confirmation shows exactly the address that opens: invisible and right-to-left
  characters percent-encoded and international host names in their `xn--` form.
- Terminal output can no longer make the browser send focus reports: they follow real focus
  changes only, and attaching from another device no longer takes over the session's size.
- The 404 page and other pages under paths such as `/apix` get the Content-Security-Policy too.
- The daemon keeps at most 16 idle runtimes of ended sessions per user, caps tmux control-mode
  replies, cuts host text in its errors, logs and session events to 300 clean characters,
  closes a WebSocket whose sign-in check keeps failing, and answers a failed leftover End with
  a fixed message instead of the transport's text.
- Caddy answers `400` to WebSocket upgrades outside `/ws` and removes its `Server` header from
  redirects and error responses too. Backups write their partial file exclusively.

From the review of the file panel (2026-10-19), against a hostile or broken SFTP server and other
users of that server:

- Replacing a file keeps its permissions from the first byte: the temporary upload file is never
  readable more widely than the file it replaces, and no permission is changed by path.
- The session-manager's memory is bounded whatever the server answers: a listing stops at 10 000
  entries or 2 MiB of names and link texts; a download holds at most 16 chunks ahead of what the
  browser received, in whatever order the server answers; Delete reads each folder once and
  closes it before deleting in it, and stops past 64 nested levels or 100 000 entries per request
  (what it deleted stays deleted; the panel then says, in the user's language, to delete such a
  tree from the terminal).
- An SFTP server that leaves its oldest request unanswered for 60 s loses the channel, so it can
  no longer hold transfers or file requests; a download the browser takes nothing from for 2
  minutes stops; at most 64 transfers run at once per session-manager.
- Running transfers check their sign-in again every 60 s, so a sign-out session-manager missed
  still stops them.
- Remote names with control, invisible or unusual space characters show those characters as
  U+FFFD, with the exact name in the tooltip, in the panel and the admin audit log; every name is
  drawn in its own left-to-right isolate. Downloads drop invisible characters from the saved name
  and send `Cross-Origin-Resource-Policy: same-origin`.
- A download's audit row is written when it ends, with the bytes transferred and whether it
  completed. SFTP server messages are cleaned before they reach error answers and logs.

[Unreleased]: https://github.com/ativaone/termavox/commits/main
