# Installing Termavox with Docker Compose

This guide runs the whole system on one Linux host with a single command: **Caddy** (TLS and the only public listener), **web** (the Next.js control plane) and **session-manager** (the daemon that holds your SSH sessions). The architecture behind it is described in [`docs/implementation-plan.md`](../implementation-plan.md) (§4.3 network, §10.2 hardening, §13 operations).

> [!WARNING]
> Termavox 0.1.0 is the first supported release: internally reviewed twice, not externally audited. Read the [security model](../security.md) before you expose it to the internet or use it with production servers.

## What you get

```text
            :80 / :443
 browser ──────────────▶ caddy ──/ws──────────▶ session-manager:3001  (WebSocket)
                           │                         ▲
                           └──everything else──▶ web:3000 ──internal──┘ :3002 (internal API)
```

- One origin: the browser only talks to Caddy. `/ws` goes to session-manager, everything else to web.
- Two networks. `edge` connects Caddy to web and session-manager. `internal` connects only web and session-manager. Caddy is not on `internal`, and the daemon's internal API listens only on its `internal` address.
- One shared volume, `termavox-data`, holds the SQLite database (`/data/app.db`). session-manager applies migrations at boot, and web waits for it to be healthy.
- Hardened containers: every service has a read-only root filesystem, a `/tmp` tmpfs, every Linux capability dropped and `no-new-privileges`, and none runs as root. web and session-manager run as UID/GID `10001`, Caddy as `10002`. Caddy binds ports 80 and 443 through a setting of its own container's network namespace (`net.ipv4.ip_unprivileged_port_start=0`), not a capability.
- Published images: each release puts three images on GitHub's container registry, for `linux/amd64` and `linux/arm64`: `ghcr.io/ativaone/termavox-caddy`, `ghcr.io/ativaone/termavox-web` and `ghcr.io/ativaone/termavox-session-manager`, tagged with the version and published with a signed build provenance attestation ([Verifying the images](#verifying-the-images)). `deploy/compose.yaml` at a release tag names that release's images. It can also build them from the checkout instead ([Building from source](#building-from-source)).

## Prerequisites

- A Linux host (x86_64 or arm64) with **Docker Engine 25 or newer** and the **Compose v2 plugin**. Tested with Engine 27.2 and Compose 2.29. Rootful Docker is assumed: with rootless Docker, container UIDs map to subordinate IDs and the secret permissions below don't apply as written.
- `bash`, `git` and `openssl` on the host.
- Free host ports: 80 and 443 by default (configurable).
- Network access to `ghcr.io` for the images, and to Docker Hub if `init-secrets.sh` needs its throwaway container ([step 2](#2-create-the-secrets)). Browsers never contact a CDN: the app serves its fonts itself.
- For a public domain: a DNS record that points to the host, and ports 80 and 443 reachable from the internet so Caddy can obtain a certificate.

## 1. Get the release

```bash
git clone https://github.com/ativaone/termavox.git termavox
cd termavox
git checkout v0.1.0
```

Check out the release you install: its tag, `vX.Y.Z`, from the [releases page](https://github.com/ativaone/termavox/releases). The checkout holds `deploy/compose.yaml`, which names that release's images, and the scripts below. Run every command from the repository root.

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
| `TERMAVOX_DOMAIN` | `localhost` | The name browsers use, and Caddy's site address |
| `TERMAVOX_HTTP_PORT` | `80` | HTTP port, published on the host. It redirects to HTTPS on `TERMAVOX_HTTPS_PORT` |
| `TERMAVOX_HTTPS_PORT` | `443` | HTTPS port, published on the host (TCP, plus UDP for HTTP/3). Caddy listens on the same ports inside its container |
| `TERMAVOX_PUBLIC_URL` | `https://<domain>:<https port>` | The browser-facing URL. It is used for Origin checks and cookies, and a `:443` suffix is normalized away. Set it only when browsers reach Termavox under another URL, for example through a port forward |
| `TERMAVOX_TLS` | `auto` (the env template sets `internal`) | `internal` for localhost, IP addresses and LAN names; `auto` for a public domain; `off` behind a reverse proxy (see [Domain and TLS](#domain-and-tls)) |
| `TERMAVOX_BIND_ADDRESS` | unset (every interface) | Host address the ports are published on, e.g. `127.0.0.1` behind a reverse proxy on the same host |
| `TERMAVOX_REVERSE_PROXY` | unset | With `TERMAVOX_TLS=off`: the reverse proxy's address as Caddy sees it, whose `X-Forwarded-For` is believed (see [Behind a reverse proxy](#behind-a-reverse-proxy)) |
| `TERMAVOX_LOG_LEVEL` | `info` | session-manager log level |
| `TERMAVOX_DAEMON_MEM_LIMIT` | `1g` | Memory limit of the session-manager container (Compose `mem_limit`). Raise it for many concurrent sessions or long scrollback |
| `TERMAVOX_WEB_MEM_LIMIT` | `768m` | Memory limit of the web container |
| `TERMAVOX_SSH_ALLOW_LOCAL_TARGETS` | `false` | `true` lets servers point at loopback, link-local, multicast or session-manager's own addresses (see [SSH targets](#ssh-targets)) |

`TERMAVOX_ENABLE_LOCAL_SHELL` is fixed to `false` in the containers. Local direct mode is meant for running session-manager outside Docker (plan §13.3).

Every container also has a process limit (`pids_limit`: session-manager 512, web 256, Caddy 128), and Caddy a fixed 256 MiB memory limit. A container that reaches its memory limit is killed and restarted by Docker. Protected sessions survive a session-manager restart; check `docker compose -f deploy/compose.yaml ps` and the logs if it happens.

### SSH targets

session-manager resolves each server's address itself and connects only to an address it allows, both for sessions and for **Test connection**. By default it refuses loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, where cloud metadata services live, and `fe80::/10`), unspecified (`0.0.0.0`, `::`) and multicast addresses, and the addresses of its own network interfaces, IPv4-mapped IPv6 forms included. Such a server fails with "not allowed" instead of connecting, and is not retried. Private LAN ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`) stay allowed, and so does the Docker host behind `host.docker.internal`.

Set `TERMAVOX_SSH_ALLOW_LOCAL_TARGETS=true` to allow those addresses too, for example when session-manager runs outside Docker and should reach an SSH server on the same machine. Test connection is also limited to 10 checks per user per minute.

## 4. Start

```bash
docker compose -f deploy/compose.yaml pull
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml ps
```

`pull` downloads the release's three images. When all three services show `healthy` (Caddy shows `running`), open `https://localhost` (or your domain).

### Verifying the images

Every image of a release is built by the release workflow of this repository, from the tagged commit, and published with a signed build provenance attestation. To check one before you run it, with the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify oci://ghcr.io/ativaone/termavox-web:0.1.0 --repo ativaone/termavox
```

Do the same for `termavox-session-manager` and `termavox-caddy`. The command fails unless the image's digest was attested by a workflow of `ativaone/termavox`, and prints the workflow and commit it came from.

### Building from source

To build the images yourself from the checkout instead of pulling them, for example to run a commit between releases:

```bash
docker compose -f deploy/compose.yaml up -d --build
```

This builds the three images (the web image runs a Next.js production build: build when the host has a couple of GB of memory free) and tags them with the names in `deploy/compose.yaml`, in place of the published ones. It needs Docker Hub (the base images `node:24-bookworm-slim` and `caddy:2`, pinned by digest) and the npm registry (pnpm 11.14.0 and the packages in `pnpm-lock.yaml`). Only a release tag's `deploy/compose.yaml` names images built from that same source: on any other commit, build from source. Upgrades then use `up -d --build` in place of `pull` and `up -d`.

## 5. Create the first admin

While no user exists, web logs a **one-time setup token** at startup:

```bash
docker compose -f deploy/compose.yaml logs web | grep "setup token:" | tail -n 1
```

Open `/setup` (the log line contains the full URL), enter the token, and choose the admin's username, email and password. Setup closes as soon as the first admin exists, and no token is generated after that.

The token lives only in web's memory (and in that log line), so every start of web logs a new one and the earlier one stops working: after an upgrade or a restart, copy the token again. If you lose it, `docker compose -f deploy/compose.yaml restart web` logs a new one. Treat the logs as sensitive until setup is done.

## 6. Add your first server

Sign in. The empty workspace offers **Add your first server**, which opens one page with two sections: the server (a name, its address and port, and the user name on it, like an `ssh user@host` command line) and the credential (generate a new key, paste a private key, a password, or none, in which case the server asks for the password in the terminal). Nothing is saved until you submit it. For a generated key, the page then shows the public key and a one-line command that adds it to `~/.ssh/authorized_keys` on the server. **Start a session** opens it in the workspace, where the first connection shows the server's host key fingerprint for you to check and trust. To reach the same machine as another user, use **Duplicate** on the server and change the user name.

## Domain and TLS

- **`TERMAVOX_TLS=internal`** uses Caddy's own local CA, with certificates valid for 30 days: for `localhost`, IP addresses and LAN-only names such as `termavox.lan` that no public CA can validate. `deploy/.env.example` sets it for the localhost trial.
- **`TERMAVOX_TLS=off`** serves plain HTTP for a reverse proxy in front that terminates TLS: see [Behind a reverse proxy](#behind-a-reverse-proxy).
- **`TERMAVOX_TLS=auto`** (the default when the variable is not set) uses Caddy's automatic HTTPS. For a public domain, it obtains a Let's Encrypt or ZeroSSL certificate over ACME, which needs ports 80 and 443 reachable from the internet. For `localhost` and IP addresses it falls back to the local CA, but with Caddy's default 12-hour certificates, so prefer `internal` there.

To switch from the localhost trial to a real domain, set `TERMAVOX_DOMAIN=termavox.example.com` and `TERMAVOX_TLS=auto` in `deploy/.env` and run `docker compose -f deploy/compose.yaml up -d`. Compose recreates the containers with the new domain and public URL.

Browsers do not trust Caddy's local CA by default. To trust it on a machine, export the root certificate and import it into that machine's trust store or browser:

```bash
docker compose -f deploy/compose.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt ./termavox-local-ca.crt
```

The local root certificate can sign a certificate for any name, and its key lives in the `caddy-data` volume: a machine that trusts it trusts, for every HTTPS site, whoever can read that volume or take over Caddy. Prefer a real domain with ACME where you can (a DNS challenge works for a LAN-only name too); otherwise import it into a dedicated browser profile rather than the system trust store.

If you accept the browser's security warning instead, the browser accepts that one certificate. When Caddy renews it (about every 20 days with `internal`, every 8 hours with `auto` on localhost), new requests are refused until you reload the page and accept the warning again, while terminals already open keep working: an action then says it could not reach Termavox. Importing the root certificate avoids this.

The certificates and the local CA live in the `caddy-data` volume, so they survive restarts and upgrades.

HSTS (`max-age=31536000`) is sent for every name except `localhost`. HSTS applies per host rather than per port, so on `localhost` it would force HTTPS on every other local development server in your browser.

## Behind a reverse proxy

When the host already runs a reverse proxy on ports 80 and 443 (nginx, Traefik, a load balancer) with a valid certificate, let it terminate TLS and forward plain HTTP to Termavox. Give Termavox its own name at the root, such as `termavox.example.com`: a sub-path such as `example.com/termavox` is not supported yet.

In `deploy/.env` (the same block, commented, is in `deploy/.env.example`):

```bash
TERMAVOX_DOMAIN=termavox.example.com
TERMAVOX_TLS=off
TERMAVOX_HTTP_PORT=8080
TERMAVOX_HTTPS_PORT=8443
TERMAVOX_BIND_ADDRESS=127.0.0.1
TERMAVOX_REVERSE_PROXY=172.30.10.1
TERMAVOX_PUBLIC_URL=https://termavox.example.com
```

- **`TERMAVOX_TLS=off`**: Caddy serves plain HTTP on `TERMAVOX_HTTP_PORT`, with no certificate and no redirect. `TERMAVOX_HTTPS_PORT` is not used, but Docker still reserves it on the host: pick a free port, never the proxy's 443.
- **`TERMAVOX_BIND_ADDRESS=127.0.0.1`** publishes the ports on the loopback address only, so nothing reaches Termavox without going through the proxy. Leave it unset when the proxy runs on another machine, and limit access with a firewall instead.
- **`TERMAVOX_REVERSE_PROXY`** is required: the proxy's address as Caddy sees it. Caddy believes `X-Forwarded-For` only from that address, so login rate limits, lockout and the activity and audit logs see each user's own address; without it, every user would show up with the proxy's address and share one sign-in lockout and rate limit, so Caddy answers every request with `503` and a message naming the setting until it is set. A proxy on the same host reaches Termavox through the gateway of Docker's `edge` network, `172.30.10.1` (the subnet is set in `deploy/compose.yaml`). For a proxy elsewhere, use its address; separate several addresses or CIDR ranges with spaces. If the activity page shows the same address for every user, that address is the proxy's.
- **`TERMAVOX_PUBLIC_URL`** is the address browsers use, without a port.

Then `docker compose -f deploy/compose.yaml up -d`.

Whatever the proxy, it must:

1. forward the original `Host` header: Termavox compares it with the browser's `Origin`;
2. set `X-Forwarded-For` to the client's address (replacing any value the client sent) and `X-Forwarded-Proto` to `https`;
3. pass WebSocket upgrades (HTTP/1.1 with the `Upgrade` and `Connection` headers): every terminal runs over a WebSocket on `/ws`;
4. keep idle connections open longer than a minute: the browser pings every 25 seconds;
5. not buffer responses, so terminal output and page streams arrive as they are sent;
6. not limit or buffer request bodies: the file panel's uploads stream through `/transfer/` and can be any size. A proxy that limits them answers `413` and the panel says a proxy refused the file (nginx's default limit is 1 MB; Cloudflare's proxy caps uploads at 100 MB on its free plan);
7. redirect plain HTTP to HTTPS itself: in this mode Termavox never sees port 80.

An nginx example, with the certificate already in place (certbot or any other source):

```nginx
# In the http block (once): the Connection header for WebSocket upgrades.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    # HTTP/2 is optional: `http2 on;` needs nginx 1.25.1 or newer (older ones fail on it).
    server_name termavox.example.com;

    ssl_certificate     /etc/letsencrypt/live/termavox.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/termavox.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
        proxy_buffering off;
        # File panel uploads (/transfer/): any size, streamed to Termavox as they arrive. Without
        # the first two lines nginx refuses files over 1 MB (413) and spools the others to its disk
        # before passing them on; the third keeps a pause on a slow server from cutting an upload.
        client_max_body_size 0;
        proxy_request_buffering off;
        proxy_send_timeout 1h;
    }
}

server {
    listen 80;
    server_name termavox.example.com;
    return 301 https://$host$request_uri;
}
```

Termavox still sends its own security headers, HSTS included, and the proxy passes them through.

## The "This Docker host" preset

session-manager can reach the Docker host itself as `host.docker.internal`. Compose maps that name to the host gateway (`extra_hosts: host.docker.internal:host-gateway`). The "Add this Docker host" preset (`/servers/docker`, linked from the servers list and the Add server page) generates an ed25519 key, creates a server `<user>@host.docker.internal:22` that uses it, and shows the `authorized_keys` line to install for that user. The first connection goes through the normal host-key trust flow.

On the host, `sshd` must accept connections from the container network. By default it listens on all addresses, which is enough. If a firewall such as `ufw` filters incoming traffic, allow port 22 from the compose `edge` subnet:

```bash
docker network inspect termavox_edge --format '{{(index .IPAM.Config 0).Subnet}}'
```

## Backups

```bash
deploy/scripts/backup.sh                 # writes deploy/backups/termavox-<UTC timestamp>.db
deploy/scripts/backup.sh /srv/backups    # or another directory
```

The backup is safe while everything runs. Inside the session-manager container, SQLite's `VACUUM INTO` writes a consistent copy, and `PRAGMA integrity_check` verifies it. The script then streams the copy to the host (directory mode `0700`, file mode `0600`). The file contains password hashes and encrypted credentials, so store it like a secret, in a directory only you can write to. It never contains the master key: back up `deploy/secrets/master_key` separately.

The script needs no TTY, so you can schedule it, for example with this crontab line (daily at 03:15):

```text
15 3 * * * cd /path/to/termavox && deploy/scripts/backup.sh /srv/backups/termavox >/dev/null
```

### Restore

```bash
deploy/scripts/restore.sh deploy/backups/termavox-20261015T031500Z.db
```

The script asks you to type `restore`, or takes `--yes` for automation, and then:

1. Takes a safety backup of the current database, if session-manager is running.
2. Stops web and session-manager.
3. Streams the backup into the volume, checks it with `PRAGMA integrity_check`, and swaps it in. The previous `app.db` and its `-wal`/`-shm` files stay in the volume as `app.db.pre-restore-<timestamp>`, so a stale WAL is never replayed over the restored file.
4. Starts the same containers again with `docker compose start`, so nothing is recreated and the configuration stays as it was, and waits until web and session-manager are healthy. session-manager applies newer migrations if the backup is older than the code.

The `master_key` must be the one in use when the backup was taken.

## Rotating the master key

Rotate the master key when it may have been exposed (a copied secrets directory, a host you no longer trust, someone with access leaving), or on a schedule if your policy asks for one. Every stored credential is re-encrypted under a new key; servers and sessions stay as they are.

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
- Older database copies are still encrypted under the old key: the files `backup.sh` wrote and the `app.db.pre-restore-*` copies in the volume. If the old key may have leaked, delete them or keep them as safe as the old key.
- Rotating the master key does not change the SSH secrets themselves. If a database copy may have leaked together with the old key, replace the credentials on the servers too (new keys, new passwords).
- The script refuses to run again while `master_key.old` or `master_key.new` exists.

To roll back, for example when session-manager does not become healthy with the new key, return to the old key and the pre-rotate backup. Changes made after the rotation are lost:

```bash
docker compose -f deploy/compose.yaml stop session-manager
mv deploy/secrets/master_key deploy/secrets/master_key.rotated
mv deploy/secrets/master_key.old deploy/secrets/master_key && chmod 0440 deploy/secrets/master_key
deploy/scripts/restore.sh --yes deploy/backups/pre-rotate-<timestamp>.db
```

**Without Compose** (session-manager run by hand, plan §13.3): stop session-manager, create the new key, run the CLI, and start session-manager again with the new key in `TERMAVOX_MASTER_KEY_FILE`.

```bash
(umask 077 && openssl rand -base64 32 > /path/to/master_key.new)
pnpm --filter @termavox/session-manager vault:rotate \
  --old-key-file /path/to/master_key --new-key-file /path/to/master_key.new --data-dir /path/to/data
```

`--dry-run` checks that every credential decrypts with the old key and writes nothing. The CLI refuses equal keys and a wrong old key, refuses to run while session-manager holds the data directory (`session-manager.lock` beside `app.db`; the lock is released when its holder exits, even after a crash), and never prints key material. Exit status 3 means the database already uses the new key.

## Resetting a password

An admin resets another user's password on that user's admin page. When no admin can sign in, for example because the only admin forgot their password, reset it from the host:

```bash
deploy/scripts/reset-password.sh <username>
deploy/scripts/reset-password.sh --reset-totp <username>   # the authenticator is lost too
```

The script runs `reset-password` inside the running session-manager container and prints a temporary password once:

```text
reset-password: alice (admin)
temporary password: k3v7qz2mxa5rtw4ybn6d

Sign in with it: Termavox then asks for a new password.
2 sign-ins ended; open terminals were disconnected (their sessions keep running).
```

- Give the username, not the email: Termavox signs in by username. An unknown username changes nothing, and the message lists the existing usernames.
- The user signs in with the temporary password and must choose a new one before anything else opens.
- Every sign-in of the user ends and their open terminals disconnect; their sessions keep running.
- TOTP stays on: sign-in still asks for a code, or for one of the backup codes shown when TOTP was set up. When the authenticator and the backup codes are both lost, add `--reset-totp`: it removes the authenticator, the backup codes and the trusted devices. The user sets TOTP up again right after the new password when it is required for them, and otherwise whenever they want, in their account settings.
- The audit log records it as **Password reset** (and **Two-step reset** with `--reset-totp`), with **System** as the actor.
- After several failed attempts, sign-in stays locked for that username and address for up to 15 minutes. The lockout lives in web's memory: `docker compose -f deploy/compose.yaml restart web` clears it.

Anyone who can run Docker commands on the host can do this. That is no new power: such access already reaches the database and the master key.

**Without Compose** (session-manager run by hand, plan §13.3): `pnpm --filter @termavox/session-manager reset-password <username> --data-dir /path/to/data`. Without the internal API settings in its environment, it cannot ask session-manager to disconnect open terminals, and says so.

## Upgrades

An upgrade is: the new release's tag, its images, restart. Run every command from the repository root.

1. **Read the release notes.** `CHANGELOG.md` (and the release on GitHub) lists each version's changes; an **Upgrade notes** entry there names anything you must do by hand. Do this before pulling.
2. **Back up.** `deploy/scripts/backup.sh` (see [Backups](#backups)).
3. **Check out the new release.** `git fetch --tags && git checkout vX.Y.Z`.
4. **Pull and restart.**

   ```bash
   docker compose -f deploy/compose.yaml pull
   docker compose -f deploy/compose.yaml up -d
   ```

   `pull` downloads the new version's images, and `up -d` recreates the containers whose image or settings changed. Caddy's configuration is part of its image, so a new Caddyfile comes with it. Database migrations apply on their own when session-manager starts; there is no separate migration command. Your secrets in `deploy/secrets/` and `deploy/.env` are kept. An install [built from source](#building-from-source) runs `docker compose -f deploy/compose.yaml up -d --build` instead of these two commands.
5. **Check it.** `docker compose -f deploy/compose.yaml ps` shows every service `healthy` after a minute; `docker compose -f deploy/compose.yaml logs session-manager` shows the migrations it applied, if any.
6. **Optionally reclaim disk.** `docker image prune` removes the previous images.

What users notice: web restarts freely. Protected (tmux) sessions keep running on their servers across the upgrade, and session-manager reattaches them when it starts again: browsers show "Restoring…", and the sessions come back as they were. Unprotected sessions end.

**Going back.** Check out the previous version's tag, pull and restart (step 4), and restore the backup from step 2 with `deploy/scripts/restore.sh` if the new version already migrated the database.

**When the notes say the data cannot be migrated.** This happens only before v1.0, when the data model changes without a migration path. The notes say so explicitly. Then start from an empty database instead of step 4:

1. **While the old version still runs, end all sessions:** in the workspace, **End all sessions…** at the foot of the session list (each user with running sessions does this in their own workspace). Otherwise the tmux of every protected session keeps running on its server, and the new database knows nothing about it. If you skip it, the new version lists those sessions on each server's page, under **Sessions on this server** → **Check now**, where you can adopt or end them.
2. **Delete the database and start the new version:**

   ```bash
   docker compose -f deploy/compose.yaml down
   docker volume rm termavox_termavox-data
   docker compose -f deploy/compose.yaml pull
   docker compose -f deploy/compose.yaml up -d
   ```

   `docker volume rm termavox_termavox-data` deletes only the database volume (users, servers, credentials, session history). The certificate volumes (with Caddy's local CA) and the secret files stay, so browsers and phones that already trust that CA keep working.
3. **Create the first admin again** with a new setup token ([step 5](#5-create-the-first-admin)), as on a new install.

## Day-to-day operations

| Task | Command |
|---|---|
| Status and health | `docker compose -f deploy/compose.yaml ps` |
| Logs (session-manager logs JSON) | `docker compose -f deploy/compose.yaml logs -f session-manager web caddy` |
| Stop / start | `docker compose -f deploy/compose.yaml stop` / `... start` |
| Temporary password for a user (no admin can sign in) | `deploy/scripts/reset-password.sh <username>` |
| Remove the containers, keep the data | `docker compose -f deploy/compose.yaml down` |
| Remove **everything**, including the database and certificates (irreversible) | `docker compose -f deploy/compose.yaml down -v` |

The health endpoints are `GET /api/health` on web and `GET /internal/v1/health` on session-manager (bearer token, `internal` network only). The compose healthchecks use both.

## Troubleshooting

- **session-manager or web logs `EACCES` on `/run/secrets/...`.** The secret files are not group 10001 with mode `0440`. Re-run `deploy/scripts/init-secrets.sh` (it refuses to overwrite, so delete the files first or fix the group as it suggests), or run `sudo chgrp 10001 deploy/secrets/* && chmod 0440 deploy/secrets/*`.
- **session-manager exits at boot with a vault key check error.** `master_key` is not the key the database is encrypted with: the original key, or the newest one after a rotation. Put that key back (after a rotation, `master_key.old` holds the previous one).
- **session-manager exits at boot because the data directory is in use.** Another session-manager or a running `vault rotate` holds `/data/session-manager.lock`. Let the rotation finish, or stop the other process; the lock is released as soon as its holder exits.
- **Login or setup fails with an origin error, or the terminal never connects.** The URL in the browser's address bar must match `TERMAVOX_PUBLIC_URL` (scheme, host and port). Set it explicitly when the default `https://<domain>:<https port>` is not what browsers use.
- **Nobody can sign in as an admin, or a password you are sure of is refused.** Sign-in is by username, not email. Set a temporary password from the host with `deploy/scripts/reset-password.sh <username>` (see [Resetting a password](#resetting-a-password)).
- **`bind: address already in use` on start.** Another service holds port 80 or 443. Pick other ports with `TERMAVOX_HTTP_PORT` and `TERMAVOX_HTTPS_PORT`, or stop that service.
