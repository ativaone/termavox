# Changelog

All notable changes to Termdock are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

The first release, v0.1.0, is being prepared.

### Added

- Persistent SSH sessions owned by the server: closing the browser, losing the network or
  restarting the web app never ends a terminal. Browsers attach to an authoritative server-side
  emulator and get an exact snapshot followed by the live stream.
- Automatic, invisible tmux protection through tmux control mode (tmux ≥ 3.2), with
  auto-detection and a graceful unprotected fallback. Protected sessions survive daemon
  restarts and network drops ("Restoring…").
- Workspace with session lanes, tabs and split panes; the layout is saved on the server and
  restored in any browser. Several browsers can attach to one session at once.
- Phone support: responsive layout and an extra-key bar (Esc, Tab, Ctrl, arrows, paste).
- Multi-user with strict per-user isolation of hosts, credentials, profiles and sessions.
- SSH authentication with private keys (with passphrase), passwords and keyboard-interactive
  prompts (OTP/2FA) relayed to the browser.
- Host-key trust on first use with an explicit decision, hard failure on mismatch, and host
  diagnostics to test, replace or revoke keys.
- Web sign-in with username and password plus optional TOTP (admins can require it), backup
  codes, rate limits and lockout.
- Administration: users, roles, instance settings and an audit log; per-user activity history.
- English and Brazilian Portuguese UI.
- Docker Compose deployment behind Caddy (automatic HTTPS), hardened containers, backup and
  restore scripts.
- Master key rotation, all or nothing and after a backup: `deploy/scripts/rotate-master-key.sh`.

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
