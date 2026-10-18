# Changelog

All notable changes to Termdock are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

The first release, v0.1.0, is being prepared.

### Upgrade notes

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

[Unreleased]: https://github.com/ativaone/termdock/commits/main
