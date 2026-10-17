# Installing Termdock with Docker Compose

This guide runs the whole system on one Linux host with a single command: **Caddy** (TLS and the only public listener), **web** (the Next.js control plane) and **session-manager** (the daemon that holds your SSH sessions). The architecture behind it is described in [`docs/implementation-plan.md`](../implementation-plan.md) (§4.3 network, §10.2 hardening, §13 operations).

> [!WARNING]
> Termdock is pre-alpha. Do not expose it to the internet or use it with production servers before the first release and its security review.

## What you get

```text
            :80 / :443
 browser ──────────────▶ caddy ──/ws──────────▶ session-manager:3001  (WebSocket)
                           │                         ▲
                           └──everything else──▶ web:3000 ──internal──┘ :3002 (internal API)
```

- One origin: the browser only talks to Caddy. `/ws` goes to session-manager, everything else to web.
- Two networks. `edge` connects Caddy to web and session-manager. `internal` connects only web and session-manager. Caddy is not on `internal`, and the daemon's internal API listens only on its `internal` address.
- One shared volume, `termdock-data`, holds the SQLite database (`/data/app.db`). session-manager applies migrations at boot, and web waits for it to be healthy.
- Hardened containers: web and session-manager run as UID/GID `10001`, with a read-only root filesystem, a `/tmp` tmpfs, every Linux capability dropped and `no-new-privileges`. Caddy runs the same way but keeps only `NET_BIND_SERVICE`.

## Prerequisites

- A Linux host (x86_64 or arm64) with **Docker Engine 25 or newer** and the **Compose v2 plugin**. Tested with Engine 27.2 and Compose 2.29. Rootful Docker is assumed: with rootless Docker, container UIDs map to subordinate IDs and the secret permissions below don't apply as written.
- `bash`, `git` and `openssl` on the host.
- Free host ports: 80 and 443 by default (configurable).
- Network access while building: Docker Hub (the two base images `node:24-bookworm-slim` and `caddy:2`, pinned by digest) and the npm registry (pnpm 11.14.0 and the packages in `pnpm-lock.yaml`, including the two fonts, which the app serves itself — browsers never contact a font CDN).
- Memory for the build: the web image runs a Next.js production build, the heaviest step. Build when the host has a couple of GB free. At runtime, the two Node processes need far less.
- For a public domain: a DNS record that points to the host, and ports 80 and 443 reachable from the internet so Caddy can obtain a certificate.

## 1. Get the code

```bash
git clone <repository-url> termdock
cd termdock
```

Run every command below from the repository root.

## 2. Create the secrets

```bash
deploy/scripts/init-secrets.sh
```

This writes four files to `deploy/secrets/` (gitignored; directory mode `0700`), the directory `deploy/compose.yaml` reads them from:

| File | Content | Used by |
|---|---|---|
| `master_key` | 32 random bytes, base64. The vault key that encrypts every stored SSH credential | session-manager |
| `internal_token` | 64 hex characters. Bearer token of the internal API | web, session-manager |
| `ws_secret` | 64 hex characters. HMAC key of the WebSocket tickets | web, session-manager |
| `auth_secret` | 64 hex characters. Better Auth signing secret | web |

**Permissions.** Outside Docker Swarm, compose mounts secret files into the containers as they are: owner, group and mode come from the host file (compose's `uid`/`gid`/`mode` keys are ignored). Both images run as UID/GID 10001, so the script makes every file **owned by you, group `10001`, mode `0440`**. The containers read the files through the group; other users on the host cannot read them.

Setting group 10001 requires root unless you belong to that group. The script tries three ways, in this order:

1. A plain `chgrp`, which works when you run the script as root or belong to group 10001.
2. A throwaway root container from the pinned Node base image that runs only `chgrp 10001`, with no network. If you can use Docker, you already have that privilege.
3. `sudo chgrp`, if you run the script in a terminal.

If none of them works, the script leaves the files owner-only and prints the two commands that finish the job.

> [!IMPORTANT]
> **Back up `deploy/secrets/master_key`** somewhere safe and separate from the database backups. Losing it means losing every stored credential, and a database backup is useless without it.

The script refuses to overwrite existing files. `--force` replaces them all, but a new `master_key` makes the existing vault unreadable: session-manager then refuses to start (vault key check). To change the key of a running installation, rotate it instead (see [Rotating the master key](#rotating-the-master-key)).

## 3. Configure

Settings come from your shell environment or from `deploy/.env` (gitignored), which compose reads automatically:

```bash
cp deploy/.env.example deploy/.env
```

| Variable | Default | Meaning |
|---|---|---|
| `TERMDOCK_DOMAIN` | `localhost` | The name browsers use, and Caddy's site address |
| `TERMDOCK_HTTP_PORT` | `80` | HTTP port, published on the host. It redirects to HTTPS on `TERMDOCK_HTTPS_PORT` |
| `TERMDOCK_HTTPS_PORT` | `443` | HTTPS port, published on the host (TCP, plus UDP for HTTP/3). Caddy listens on the same ports inside its container |
| `TERMDOCK_PUBLIC_URL` | `https://<domain>:<https port>` | The browser-facing URL. It is used for Origin checks and cookies, and a `:443` suffix is normalized away. Set it only when browsers reach Termdock under another URL, for example through a port forward |
| `TERMDOCK_TLS` | `auto` | `auto` or `internal` (see [Domain and TLS](#domain-and-tls)) |
| `TERMDOCK_LOG_LEVEL` | `info` | session-manager log level |
| `TERMDOCK_DAEMON_MEM_LIMIT` | `1g` | Memory limit of the session-manager container (Compose `mem_limit`). Raise it for many concurrent sessions or long scrollback |
| `TERMDOCK_WEB_MEM_LIMIT` | `768m` | Memory limit of the web container |
| `TERMDOCK_SSH_ALLOW_LOCAL_TARGETS` | `false` | `true` lets hosts point at loopback, link-local, multicast or session-manager's own addresses (see [SSH targets](#ssh-targets)) |

`TERMDOCK_ENABLE_LOCAL_SHELL` is fixed to `false` in the containers. Local direct mode is meant for running session-manager outside Docker (plan §13.3).

Every container also has a process limit (`pids_limit`: session-manager 512, web 256, Caddy 128), and Caddy a fixed 256 MiB memory limit. A container that reaches its memory limit is killed and restarted by Docker. Protected sessions survive a session-manager restart; check `docker compose -f deploy/compose.yaml ps` and the logs if it happens.

### SSH targets

session-manager resolves each host's name itself and connects only to an address it allows, both for sessions and for **Fetch & verify**. By default it refuses loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, where cloud metadata services live, and `fe80::/10`), unspecified (`0.0.0.0`, `::`) and multicast addresses, and the addresses of its own network interfaces, IPv4-mapped IPv6 forms included. Such a host fails with "not allowed" instead of connecting, and is not retried. Private LAN ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) stay allowed, and so does the Docker host behind `host.docker.internal`.

Set `TERMDOCK_SSH_ALLOW_LOCAL_TARGETS=true` to allow those addresses too, for example when session-manager runs outside Docker and should reach an SSH server on the same machine. Fetch & verify is also limited to 10 checks per user per minute.

## 4. Start

```bash
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml ps
```

The first run builds both images, which takes a while. When all three services show `healthy` (Caddy shows `running`), open `https://localhost` (or your domain).

## 5. Create the first admin

While no user exists, web logs a **one-time setup token** at startup:

```bash
docker compose -f deploy/compose.yaml logs web | grep -i "setup token"
```

Open `/setup` (the log line contains the full URL), enter the token, and choose the admin's username, email and password. Setup closes as soon as the first admin exists, and no token is generated after that.

The token lives only in web's memory (and in that log line). If you lose it, `docker compose -f deploy/compose.yaml restart web` logs a new one. Treat the logs as sensitive until setup is done.

## 6. Add your first server

Sign in. The empty workspace offers **Add your first server**, which opens one page with three sections: the server (a name and its address), the sign-in (the user name on that server) and the credential (generate a new key, paste a private key, or a password). Nothing is saved until you submit it. For a generated key, the page then shows the public key and a one-line command that adds it to `~/.ssh/authorized_keys` on the server. **Start a session** opens it in the workspace, where the first connection shows the server's host key fingerprint for you to check and trust.

## Domain and TLS

- **`TERMDOCK_TLS=auto`** (default) uses Caddy's automatic HTTPS. For `localhost` and IP addresses, Caddy issues certificates from its own local CA, which is the same as `tls internal`. For a public domain, it obtains a Let's Encrypt or ZeroSSL certificate over ACME. That needs ports 80 and 443 reachable from the internet.
- **`TERMDOCK_TLS=internal`** always uses Caddy's local CA, for example for a LAN-only name such as `termdock.lan` that no public CA can validate.

To switch from the localhost trial to a real domain, set `TERMDOCK_DOMAIN=termdock.example.com` in `deploy/.env` (keep `TERMDOCK_TLS=auto`) and run `docker compose -f deploy/compose.yaml up -d`. Compose recreates the containers with the new domain and public URL.

Browsers do not trust Caddy's local CA by default. To trust it on a machine, export the root certificate and import it into that machine's trust store or browser:

```bash
docker compose -f deploy/compose.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt ./termdock-local-ca.crt
```

The certificates and the local CA live in the `caddy-data` volume, so they survive restarts and upgrades.

HSTS (`max-age=31536000`) is sent for every name except `localhost`. HSTS applies per host rather than per port, so on `localhost` it would force HTTPS on every other local development server in your browser.

## The "This Docker host" preset

session-manager can reach the Docker host itself as `host.docker.internal`. Compose maps that name to the host gateway (`extra_hosts: host.docker.internal:host-gateway`). The "Add this Docker host" preset (`/hosts/docker`, linked from the hosts list and the Add server page) creates a host `host.docker.internal:22`, generates an ed25519 key, and shows the `authorized_keys` line to install for the host user. The first connection goes through the normal host-key trust flow.

On the host, `sshd` must accept connections from the container network. By default it listens on all addresses, which is enough. If a firewall such as `ufw` filters incoming traffic, allow port 22 from the compose `edge` subnet:

```bash
docker network inspect termdock_edge --format '{{(index .IPAM.Config 0).Subnet}}'
```

## Backups

```bash
deploy/scripts/backup.sh                 # writes deploy/backups/termdock-<UTC timestamp>.db
deploy/scripts/backup.sh /srv/backups    # or another directory
```

The backup is safe while everything runs. Inside the session-manager container, SQLite's `VACUUM INTO` writes a consistent copy, and `PRAGMA integrity_check` verifies it. The script then streams the copy to the host (directory mode `0700`, file mode `0600`). The file contains password hashes and encrypted credentials, so store it like a secret. It never contains the master key: back up `deploy/secrets/master_key` separately.

The script needs no TTY, so you can schedule it, for example with this crontab line (daily at 03:15):

```text
15 3 * * * cd /path/to/termdock && deploy/scripts/backup.sh /srv/backups/termdock >/dev/null
```

### Restore

```bash
deploy/scripts/restore.sh deploy/backups/termdock-20261015T031500Z.db
```

The script asks you to type `restore`, or takes `--yes` for automation, and then:

1. Takes a safety backup of the current database, if session-manager is running.
2. Stops web and session-manager.
3. Streams the backup into the volume, checks it with `PRAGMA integrity_check`, and swaps it in. The previous `app.db` and its `-wal`/`-shm` files stay in the volume as `app.db.pre-restore-<timestamp>`, so a stale WAL is never replayed over the restored file.
4. Starts the same containers again with `docker compose start`, so nothing is recreated and the configuration stays as it was, and waits until web and session-manager are healthy. session-manager applies newer migrations if the backup is older than the code.

The `master_key` must be the one in use when the backup was taken.

## Rotating the master key

Rotate the master key when it may have been exposed (a copied secrets directory, a host you no longer trust, someone with access leaving), or on a schedule if your policy asks for one. Every stored credential is re-encrypted under a new key; hosts, profiles and sessions stay as they are.

```bash
deploy/scripts/rotate-master-key.sh
```

The script asks you to type `rotate`, or takes `--yes` for automation, and then:

1. Generates `deploy/secrets/master_key.new` the way `init-secrets.sh` does: 32 random bytes, group `10001`, mode `0440`.
2. Stops session-manager. Open terminals disconnect, protected sessions are restored when it starts again, and unprotected sessions end. web keeps running.
3. Runs `vault rotate` in a one-off session-manager container, with the same image, user and data volume, and both keys mounted read-only. It checks the current key against the database's vault key check, writes a consistent backup next to the database (`/data/pre-rotate-<timestamp>.db`, mode `0600`), and re-encrypts every credential and the key check in one transaction: all or nothing.
4. Keeps the old key as `deploy/secrets/master_key.old` (mode `0400`), installs the new key as `master_key`, copies the backup to `deploy/backups/`, and starts session-manager, which verifies the new key at boot.

If the rotation fails, the database and `master_key` stay as they were, session-manager starts again on the current key, and the script exits non-zero. If the script cannot tell which key the database uses, for example after an interruption, it keeps `master_key.new`, and the next run prints the steps to find out.

Afterwards:

- **Back up the new `master_key`** in place of your copy of the old one.
- Check that sessions connect. Then delete `deploy/secrets/master_key.old` and the pre-rotate backup, both on the host and in the volume (the script prints the commands). Only the old key opens that backup.
- The script refuses to run again while `master_key.old` or `master_key.new` exists.

To roll back, for example when session-manager does not become healthy with the new key, return to the old key and the pre-rotate backup. Changes made after the rotation are lost:

```bash
docker compose -f deploy/compose.yaml stop session-manager
mv deploy/secrets/master_key deploy/secrets/master_key.rotated
mv deploy/secrets/master_key.old deploy/secrets/master_key && chmod 0440 deploy/secrets/master_key
deploy/scripts/restore.sh --yes deploy/backups/pre-rotate-<timestamp>.db
```

**Without Compose** (session-manager run by hand, plan §13.3): stop session-manager, create the new key, run the CLI, and start session-manager again with the new key in `TERMDOCK_MASTER_KEY_FILE`.

```bash
(umask 077 && openssl rand -base64 32 > /path/to/master_key.new)
pnpm --filter @termdock/session-manager vault:rotate \
  --old-key-file /path/to/master_key --new-key-file /path/to/master_key.new --data-dir /path/to/data
```

`--dry-run` checks that every credential decrypts with the old key and writes nothing. The CLI refuses equal keys and a wrong old key, refuses to run while session-manager holds the data directory (`session-manager.lock` beside `app.db`; the lock is released when its holder exits, even after a crash), and never prints key material. Exit status 3 means the database already uses the new key.

## Upgrades

```bash
deploy/scripts/backup.sh
git pull
docker compose -f deploy/compose.yaml up -d --build
```

web restarts freely. A session-manager restart keeps protected (tmux) sessions: browsers show "Restoring…", and the sessions come back as they were. Unprotected sessions end. Old images can be removed afterwards with `docker image prune`.

## Day-to-day operations

| Task | Command |
|---|---|
| Status and health | `docker compose -f deploy/compose.yaml ps` |
| Logs (session-manager logs JSON) | `docker compose -f deploy/compose.yaml logs -f session-manager web caddy` |
| Stop / start | `docker compose -f deploy/compose.yaml stop` / `... start` |
| Remove the containers, keep the data | `docker compose -f deploy/compose.yaml down` |
| Remove **everything**, including the database and certificates (irreversible) | `docker compose -f deploy/compose.yaml down -v` |

The health endpoints are `GET /api/health` on web and `GET /internal/v1/health` on session-manager (bearer token, `internal` network only). The compose healthchecks use both.

## Troubleshooting

- **session-manager or web logs `EACCES` on `/run/secrets/...`.** The secret files are not group 10001 with mode `0440`. Re-run `deploy/scripts/init-secrets.sh` (it refuses to overwrite, so delete the files first or fix the group as it suggests), or run `sudo chgrp 10001 deploy/secrets/* && chmod 0440 deploy/secrets/*`.
- **session-manager exits at boot with a vault key check error.** `master_key` is not the key the database is encrypted with: the original key, or the newest one after a rotation. Put that key back (after a rotation, `master_key.old` holds the previous one).
- **session-manager exits at boot because the data directory is in use.** Another session-manager or a running `vault rotate` holds `/data/session-manager.lock`. Let the rotation finish, or stop the other process; the lock is released as soon as its holder exits.
- **Login or setup fails with an origin error, or the terminal never connects.** The URL in the browser's address bar must match `TERMDOCK_PUBLIC_URL` (scheme, host and port). Set it explicitly when the default `https://<domain>:<https port>` is not what browsers use.
- **`bind: address already in use` on start.** Another service holds port 80 or 443. Pick other ports with `TERMDOCK_HTTP_PORT` and `TERMDOCK_HTTPS_PORT`, or stop that service.
