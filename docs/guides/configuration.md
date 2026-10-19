# Configuration reference

Every setting Termdock reads: the Docker Compose variables, the environment of each service,
the secret files, ports, networks and volumes, and the instance settings admins change in the
UI. For a first installation, follow the [installation guide](install.md); for the security
meaning of these settings, see the [security model](../security.md).

The sources of truth are `apps/session-manager/src/config/config.ts`, `apps/web/lib/config.ts`,
[`deploy/compose.yaml`](../../deploy/compose.yaml), [`deploy/.env.example`](../../deploy/.env.example),
[`deploy/Caddyfile`](../../deploy/Caddyfile) and the Dockerfiles in `deploy/docker/`.

## How configuration works

- **With Docker Compose** you set only the variables in [Compose settings](#compose-settings),
  in `deploy/.env` (copy it from `deploy/.env.example`; compose reads it automatically) or in
  your shell, which takes precedence. `deploy/compose.yaml` turns them into each container's
  environment and fixes everything else. To change a fixed value, edit `deploy/compose.yaml`.
- **Outside Compose** (development, or running a service by hand) each service reads its
  variables directly from its environment; see the per-service tables.
- **Secrets are always files.** The services take the *path* of each secret file
  (`…_FILE` variables), never the secret itself. There is no `TERMDOCK_WS_SECRET`,
  `TERMDOCK_INTERNAL_TOKEN` or `BETTER_AUTH_SECRET` variable.
- **Validation.** Both services validate their environment with zod and report every invalid
  variable at once. session-manager exits at boot with
  `termdock session-manager: invalid configuration: …`. web validates when it builds its auth
  runtime: it tries at startup, logs a warning if that fails (for example while session-manager
  has not migrated the database yet), and tries again on the first request.
- **Flags** (`TERMDOCK_ENABLE_LOCAL_SHELL`, `TERMDOCK_SSH_ALLOW_LOCAL_TARGETS`) accept `true` or
  `1` for on, and `false`, `0` or an empty value for off. Any other value is a configuration
  error.

## Compose settings

These are the only variables `deploy/compose.yaml` takes from `deploy/.env` or the shell. None
is required.

| Variable | Default | Passed to | Meaning |
|---|---|---|---|
| `TERMDOCK_DOMAIN` | `localhost` | caddy | Caddy's site address: the name browsers use. Also the default host of `TERMDOCK_PUBLIC_URL`. |
| `TERMDOCK_HTTP_PORT` | `80` | caddy | HTTP port, published on the host and used inside the container. Redirects to HTTPS on `TERMDOCK_HTTPS_PORT`. |
| `TERMDOCK_HTTPS_PORT` | `443` | caddy | HTTPS port, published on the host (TCP, plus UDP for HTTP/3) and used inside the container. |
| `TERMDOCK_PUBLIC_URL` | `https://<TERMDOCK_DOMAIN>:<TERMDOCK_HTTPS_PORT>` | web, session-manager | The browser-facing URL (see the service tables). A `:443` suffix is normalized away. Set it only when browsers reach Termdock under another URL, for example through a port forward. |
| `TERMDOCK_TLS` | `auto` | caddy | `internal`: Caddy's local CA, 30-day certificates (the env template's choice, for localhost, IP addresses and LAN names). `auto`: Caddy's automatic HTTPS, ACME for public domains and the local CA with 12-hour certificates for `localhost` and IP addresses. `off`: plain HTTP for a reverse proxy in front that terminates TLS. See [Domain and TLS](install.md#domain-and-tls). |
| `TERMDOCK_BIND_ADDRESS` | unset | Compose `ports` of caddy | Host address the ports are published on (e.g. `127.0.0.1`); unset, every interface. On a host with IPv6, Docker forwards IPv6 clients to Caddy from the `edge` network's gateway address, so they all share one sign-in lockout and rate limit: `0.0.0.0` publishes on IPv4 only. |
| `TERMDOCK_REVERSE_PROXY` | unset | caddy | Addresses (IPs or CIDR ranges, space-separated) of a reverse proxy in front, as Caddy sees them: Caddy reads the client address from `X-Forwarded-For` only on their requests, right to left. Required with `TERMDOCK_TLS=off`: until it is set, Caddy answers `503`. A proxy on the same host is `172.30.10.1`. See [Behind a reverse proxy](install.md#behind-a-reverse-proxy). |
| `TERMDOCK_LOG_LEVEL` | `info` | session-manager | Daemon log level. web has no log level setting. |
| `TERMDOCK_DAEMON_MEM_LIMIT` | `1g` | Compose `mem_limit` of session-manager | Memory ceiling of the daemon container. Raise it for many concurrent sessions or long scrollback. |
| `TERMDOCK_WEB_MEM_LIMIT` | `768m` | Compose `mem_limit` of web | Memory ceiling of the web container. |
| `TERMDOCK_SSH_ALLOW_LOCAL_TARGETS` | `false` | session-manager | Allow SSH targets on loopback, link-local, multicast, unspecified or the daemon's own addresses. See [SSH targets](install.md#ssh-targets). |
| `TERMDOCK_EVENT_RETENTION_DAYS` | `180` | session-manager | Days to keep audit events and session events. See [Event retention](#event-retention). |

Caddy's memory limit (256m) and every `pids_limit` (caddy 128, web 256, session-manager 512)
are fixed in `deploy/compose.yaml`.

## session-manager environment

Read by `apps/session-manager/src/config/config.ts`.

| Variable | Required | Default | Compose value | Meaning |
|---|---|---|---|---|
| `TERMDOCK_PUBLIC_URL` | yes | — | `TERMDOCK_PUBLIC_URL` (derived, see above) | An `http` or `https` URL. Its origin must equal the `Origin` header of every WebSocket upgrade; anything else is closed with `4403`. |
| `TERMDOCK_DATA_DIR` | no | `/data` | `/data` | Data directory. The SQLite database is `<dir>/app.db`, shared with web. The daemon applies the migrations at boot. |
| `TERMDOCK_WS_HOST` | no | `0.0.0.0` | `0.0.0.0` | Listen address of the WebSocket server. |
| `TERMDOCK_WS_PORT` | no | `3001` | `3001` | Listen port of the WebSocket server (path `/ws`). |
| `TERMDOCK_WS_SECRET_FILE` | yes | — | `/run/secrets/ws_secret` | Path of the WebSocket ticket key (the content is what the code calls `TERMDOCK_WS_SECRET`). Must be the same file content web uses. |
| `TERMDOCK_INTERNAL_TOKEN_FILE` | yes | — | `/run/secrets/internal_token` | Path of the internal API bearer token. Must be the same file content web uses. |
| `TERMDOCK_MASTER_KEY_FILE` | yes | — | `/run/secrets/master_key` | Path of the vault master key. The daemon refuses to start if the key does not match the database (`vault_key_check`). |
| `TERMDOCK_INTERNAL_HOST` | no | `127.0.0.1` | `session-manager-internal` | Listen address of the internal API. Compose binds it to the alias that exists only on the `internal` network. |
| `TERMDOCK_INTERNAL_PORT` | no | `3002` | `3002` | Listen port of the internal API. |
| `TERMDOCK_TRUSTED_PROXIES` | no | empty: trust nobody | `172.30.10.0/24` (the `edge` subnet) | Comma-separated IPs and CIDRs whose connections may name the client in `X-Forwarded-For`. The daemon takes the rightmost value that is not a trusted proxy; from any other peer it uses the socket address. Used for the IP in session events. An entry that is not an IP or CIDR is a configuration error. |
| `TERMDOCK_ENABLE_LOCAL_SHELL` | no | `false` | `false` | Gate of local direct mode, which is not implemented yet (Phase 6): session-manager refuses local sessions even when it is on. Leave it off. |
| `TERMDOCK_SSH_ALLOW_LOCAL_TARGETS` | no | `false` | from the compose setting | See [Compose settings](#compose-settings). Applies to sessions and to host tests (Fetch & verify). |
| `TERMDOCK_EVENT_RETENTION_DAYS` | no | `180` | from the compose setting | Whole days: `0` keeps every row forever, otherwise `7` to `3650`. Unset or empty means `180`; any other value is a configuration error. See [Event retention](#event-retention). |
| `TERMDOCK_LOG_LEVEL` | no | `info` | from the compose setting | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs are JSON on stdout. |

The session-manager image also sets `NODE_ENV=production` and `TERMDOCK_DATA_DIR=/data`; the
daemon does not read `NODE_ENV`.

### Event retention

session-manager deletes `audit_events` and `session_events` rows older than
`TERMDOCK_EVENT_RETENTION_DAYS` days: once a few minutes after it starts, then every 6 hours.
The purge applies to the whole tables, so the audit events web writes (sign-ins, lockouts,
admin actions) age out with the daemon's own; the admin audit log and each user's activity page
show only what is left. It deletes the oldest rows first, 500 per short transaction, so other
writes are never held up, and it logs how many rows it deleted from each table (never their
contents). With `0` nothing is ever deleted. A session that has stayed failed for longer than
the retention period keeps its state, but its specific failure reason ages out with its events
and the UI shows the generic one.

## web environment

Read by `apps/web/lib/config.ts`, plus the variables below it.

| Variable | Required | Default | Compose value | Meaning |
|---|---|---|---|---|
| `TERMDOCK_PUBLIC_URL` | yes | — | `TERMDOCK_PUBLIC_URL` (derived) | An `http` or `https` URL. Better Auth's base URL and its only trusted origin; the ticket and layout endpoints compare `Origin` with it exactly; the setup URL in the logs is built from it. It must match the address bar (scheme, host and port), or sign-in and the terminal fail. |
| `TERMDOCK_DATA_DIR` | no | `/data` | `/data` | Data directory; web opens `<dir>/app.db`, which session-manager creates and migrates. |
| `BETTER_AUTH_SECRET_FILE` | yes | — | `/run/secrets/auth_secret` | Path of Better Auth's secret. |
| `TERMDOCK_WS_SECRET_FILE` | yes | — | `/run/secrets/ws_secret` | Path of the WebSocket ticket key; same content as session-manager's. |
| `TERMDOCK_INTERNAL_URL` | yes | — | `http://session-manager-internal:3002` | Base URL of session-manager's internal API (`http` or `https`). |
| `TERMDOCK_INTERNAL_TOKEN_FILE` | yes | — | `/run/secrets/internal_token` | Path of the internal API bearer token; same content as session-manager's. |

Set by the web image (`deploy/docker/web.Dockerfile`) for Next.js's standalone server:

| Variable | Value | Meaning |
|---|---|---|
| `NODE_ENV` | `production` | Production mode. With `development` (`next dev`), the page CSP also allows `'unsafe-eval'`. |
| `NEXT_TELEMETRY_DISABLED` | `1` | Turns off Next.js telemetry (also set during the image build). |
| `HOSTNAME` | `0.0.0.0` | Listen address of the Next.js server. |
| `PORT` | `3000` | Listen port of the Next.js server. Caddy proxies to `web:3000`. |
| `TERMDOCK_DATA_DIR` | `/data` | As above. |

`NEXT_RUNTIME` is set by Next.js itself (web only boots its auth runtime in the `nodejs`
runtime); it is not a setting. The build stages of both images set `CI=true` for a
non-interactive pnpm install; it does not reach the runtime images.

### Build-time variable

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_TERMDOCK_WS_URL` | unset: the browser uses same-origin `/ws` | A development override, for example `ws://localhost:3001/ws` when session-manager runs without the proxy. Next.js inlines it at `next build` (and in `next dev`), so setting it on a running container has no effect. When set, its origin is added to the page CSP's `connect-src`. The web Dockerfile does not set it. session-manager still requires the `Origin` of `TERMDOCK_PUBLIC_URL`. |

## Caddy environment

Set by `deploy/compose.yaml` from the compose settings and read by `deploy/Caddyfile`:
`TERMDOCK_DOMAIN`, `TERMDOCK_HTTP_PORT`, `TERMDOCK_HTTPS_PORT` and `TERMDOCK_TLS`, with the same
defaults as above. The upstreams `web:3000` and `session-manager:3001` are fixed in the
Caddyfile.

## Secret files

`deploy/scripts/init-secrets.sh` creates them in `deploy/secrets/` (directory mode `0700`;
each file group `10001`, mode `0440`). Compose mounts them as Docker secrets under
`/run/secrets/`.

| File | Mounted into | Variable | Format | Generated as |
|---|---|---|---|---|
| `master_key` | session-manager | `TERMDOCK_MASTER_KEY_FILE` | Standard base64 of exactly 32 bytes (surrounding whitespace ignored) | `openssl rand -base64 32` |
| `internal_token` | web, session-manager | `TERMDOCK_INTERNAL_TOKEN_FILE` | At least 32 characters after trimming | `openssl rand -hex 32` |
| `ws_secret` | web, session-manager | `TERMDOCK_WS_SECRET_FILE` | At least 32 characters after trimming | `openssl rand -hex 32` |
| `auth_secret` | web | `BETTER_AUTH_SECRET_FILE` | At least 32 characters after trimming | `openssl rand -hex 32` |

- For `internal_token`, `ws_secret` and `auth_secret`, the trimmed text itself (as UTF-8 bytes)
  is the secret; it is never base64-decoded. web and session-manager must read identical
  `internal_token` and `ws_secret` files.
- **`master_key`**: back it up separately from the database. A different key makes the daemon
  refuse to start; a lost key means every stored credential is lost. To replace it, follow
  [Rotating the master key](install.md#rotating-the-master-key); never just overwrite the file.
- **`auth_secret`**: Better Auth signs its cookies and encrypts TOTP secrets with it. Replacing
  it signs everyone out and breaks existing TOTP enrollments.
- Both services read the secret files once per process. After replacing `internal_token` or
  `ws_secret`, restart web and session-manager.
- `init-secrets.sh` refuses to overwrite existing files; `--force` replaces all four, including
  `master_key`.

## Ports

| Listener | Default | Reachable from | Configured with |
|---|---|---|---|
| Caddy HTTP | `80/tcp` | the host's network (published) | `TERMDOCK_HTTP_PORT` |
| Caddy HTTPS | `443/tcp` and `443/udp` (HTTP/3) | the host's network (published) | `TERMDOCK_HTTPS_PORT` |
| web | `3000` | the `edge` network only (Caddy) | `PORT`, `HOSTNAME` (image) |
| session-manager WebSocket | `3001` | the `edge` network only (Caddy) | `TERMDOCK_WS_HOST`, `TERMDOCK_WS_PORT` |
| session-manager internal API | `3002` | the `internal` network only (web) | `TERMDOCK_INTERNAL_HOST`, `TERMDOCK_INTERNAL_PORT` |

Only Caddy publishes ports. The ports 3000, 3001 and 3002 also appear in the Caddyfile, in
`TERMDOCK_INTERNAL_URL` and in the healthchecks of `deploy/compose.yaml`; change them together.

## Networks

| Network | Members | Notes |
|---|---|---|
| `edge` | caddy, web, session-manager | Subnet `172.30.10.0/24`, fixed in `deploy/compose.yaml` (`x-edge-subnet`) because session-manager trusts `X-Forwarded-For` from it. Change it there if it collides with a network of the host. Also the containers' outbound path (SSH). |
| `internal` | web, session-manager | `internal: true`: no gateway, no outside connectivity. session-manager carries the alias `session-manager-internal` here. Caddy is not a member. |

session-manager also maps `host.docker.internal` to the Docker host gateway, for the
"This Docker host" preset.

## Volumes and writable paths

| Volume | Mounted at | Service | Content |
|---|---|---|---|
| `termdock-data` | `/data` | web, session-manager | `app.db` and its `-wal`/`-shm` files. Back it up with `deploy/scripts/backup.sh`. Also `session-manager.lock`, the data directory lock that session-manager and `vault rotate` hold while they run (released when the holder exits, even after a crash; do not delete it while either runs). |
| `caddy-data` | `/data` | caddy | Certificates and Caddy's local CA. |
| `caddy-config` | `/config` | caddy | Caddy's autosaved configuration. |

Bind mounts: `deploy/Caddyfile` (read-only) and the four secret files. Every root filesystem is
read-only; `/tmp` is a tmpfs in every container, and web also gets a tmpfs at
`/app/apps/web/.next/cache`. SQLite's WAL mode needs a local volume shared on one kernel:
network filesystems are not supported.

`deploy/scripts/backup.sh` and `restore.sh` run inside the session-manager container and use its
`TERMDOCK_DATA_DIR` (default `/data`).

## Instance settings

Admins edit these at `/admin/settings`. They are stored in the `instance_settings` table, take
effect without a restart, and every change is audited (`admin_setting.change`).

| Setting in the UI | Key | Default | Effect |
|---|---|---|---|
| Require two-step verification for everyone | `require_totp` | off | Every user without TOTP, admins included, must enroll before anything else opens, and cannot disable TOTP. Admins can also require TOTP for single users. |
| Maximum running sessions per user | `max_running_sessions_per_user` | `50` | A whole number from 1 to 1000. Creating or reopening a session is refused (`RATE_LIMITED`) when the user already has this many sessions meant to run. |
| Show local shells (direct mode) to administrators | `local_shell_visible` | off | Offers the `local` host kind to admins. It has no effect until direct mode ships (Phase 6), and even then only with `TERMDOCK_ENABLE_LOCAL_SHELL=true` on the daemon. See the warning in the [security model](../security.md#admins-are-trusted). |

session-manager also stores two keys of its own there, which are not settings: `installation_id`
(used in the names of the remote tmux sockets) and `vault_key_check`.

Per-user preferences (language, theme, terminal font and colors, OSC 52 clipboard writes, link
confirmation) are under `/settings`, and connection options (protection mode, startup command,
`TERM`, environment, keepalive, auto-reopen, scrollback) are per server, under Advanced on its
page.

## Built-in limits

These are constants in the code, not settings.

| Limit | Value |
|---|---|
| WebSocket ticket lifetime | 30 s, single use |
| WebSocket connections per user | 16 (the next is closed with `4429`) |
| Attached terminals per user, across connections | 64 |
| Channels per connection | 32 (one more closes the connection with `4400`) |
| Messages in flight per connection | 64 (then `4429`) |
| Client frame size | 1 MiB |
| Auth-session revalidation of open WebSockets | every 60 s |
| Sign-in lockout per (username, IP) | 5 failures → 30 s, doubling up to 15 min |
| Host tests (Fetch & verify) | 10 per user per minute |
| Keyboard-interactive prompt timeout | 100 s |
| Reconnect backoff | 1 s doubling to 60 s, ±20% jitter |
| Idle runtime of a session that is not running | freed after 60 s without viewers |
| Pending host keys | expire after 24 h |
| Daemon shutdown budget | 25 s (`stop_grace_period: 30s` in compose) |

The test suites also read `TD_TMUX_IMAGES` and `TD_S4_PAUSE_MS` (under
`apps/session-manager/test/`); they are test knobs, not product settings.
