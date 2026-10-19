# Changelog

All notable changes to Termdock are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

The first release, v0.1.0, is being prepared.

### Upgrade notes

- `deploy/Caddyfile` gained the file panel's `/transfer/*` route. After `docker compose -f
  deploy/compose.yaml up -d --build`, run `docker compose -f deploy/compose.yaml restart caddy`:
  Caddy reads its Caddyfile only when it starts, and an unchanged Caddy container is not
  recreated. Without it, uploads and downloads fail while browsing still works.
- Behind your own reverse proxy, file panel uploads need it to pass request bodies of any size
  without buffering them: for nginx, add `client_max_body_size 0;`, `proxy_request_buffering off;`
  and `proxy_send_timeout 1h;` to the Termdock `location` (install guide, "Behind a reverse
  proxy"). Without them nginx refuses files over 1 MB, and the panel says a proxy refused the file.
- With `TERMDOCK_TLS=off`, Caddy now answers `503` until `TERMDOCK_REVERSE_PROXY` names the reverse
  proxy (the install guide always required it). Without it every user shared the proxy's address,
  and with it one sign-in lockout and rate limit.
- Certificates from Caddy's local CA (`TERMDOCK_TLS=internal`) now last 30 days instead of 12
  hours. A `localhost` or IP install that never set `TERMDOCK_TLS` uses `auto`, which keeps 12-hour
  certificates there: add `TERMDOCK_TLS=internal` to `deploy/.env`. Caddy switches within about a
  week, once it renews its intermediate certificate; nothing else needs to change.
- Development builds of `main` from before servers replaced hosts and connection profiles
  (plan D-29) cannot be migrated: start from an empty database as described in the
  installation guide, [Upgrades](docs/guides/install.md#upgrades), "When the notes say the data
  cannot be migrated". Protected sessions still running on your servers afterwards are listed
  on each server's page under "Sessions on this server", where you can adopt or end them.

### Added

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
- Running behind your own reverse proxy (nginx, Traefik…) that terminates TLS: `TERMDOCK_TLS=off`
  serves plain HTTP, `TERMDOCK_BIND_ADDRESS` keeps the port on loopback, and
  `TERMDOCK_REVERSE_PROXY` names the proxy so each user's own address is still seen. The install
  guide has a section for it, with an nginx example.
- A tip in the pane when you start tmux inside a protected session: Termdock already keeps the
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
- The Termdock mark as the browser icon, and a web app manifest, so a pinned tab, a taskbar
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
- Audit and session-event retention: rows older than `TERMDOCK_EVENT_RETENTION_DAYS` (default
  180, `0` keeps them forever) are purged in small chunks every 6 hours.
- Ending a session reaches its server: when the session is not connected, Termdock connects
  just to end its tmux there. If it cannot, the session ends anyway, its pane says so, and the
  next connection to that server ends the leftover.
- Leftover sessions are found: when a session connects, Termdock looks for Termdock tmux
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

### Security

Hardening from the internal pre-release security review:

- A host key the owner revoked now fails closed like any mismatch; it can only be trusted again
  through the explicit replace flow.
- SSH targets on loopback, link-local, multicast or the daemon's own addresses are refused by
  default (`TERMDOCK_SSH_ALLOW_LOCAL_TARGETS=true` allows them); host tests are rate-limited.
- Resource caps: idle runtimes of stopped sessions are evicted, WebSocket connections and
  attachments are capped per user, in-flight messages are bounded per connection, and the
  Compose services have memory and process limits.
- Capability-probe output from the host is bounded.
- Profile values the launch cannot pass safely are rejected by the form and park the session
  instead of reconnecting in a loop.
- Terminal hyperlinks (OSC 8) go through the same confirmation and scheme filter as other links.
- Keyboard-interactive prompts always carry Termdock's own framing; host text is capped and
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
  editing the display name admins see, and raw admin endpoints that skipped Termdock's own
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

[Unreleased]: https://github.com/ativaone/termdock/commits/main
