# Termavox edge proxy: the official Caddy image, run as a non-root user, with the Termavox
# Caddyfile baked in. Build context: the repository root.
#   docker compose -f deploy/compose.yaml build caddy
#
# Caddy runs as UID/GID 10002, not the 10001 of web and session-manager: an escaped Caddy must
# not own (or read) their data volume files on the host. The upstream binary carries the
# cap_net_bind_service file capability, which would make the kernel refuse to run it under
# compose's `cap_drop: [ALL]`; it is removed, and Caddy binds 80/443 (TCP and UDP) through the
# container's `net.ipv4.ip_unprivileged_port_start=0` sysctl instead (deploy/compose.yaml).
# Changing deploy/Caddyfile means rebuilding this image.

# caddy:2 (official Docker Hub image; v2.11.7 when pinned), pinned by digest.
FROM caddy:2@sha256:504a44d7d74bd2bc28a66afc4774912fc21223ca8a67734af1c54ab2f999b489
# One layer: the binary is copied up once (capability removed, owned by root like every other
# program file), and /data and /config (certificates, the local CA, the autosaved config) belong
# to the Caddy user. A new named volume takes that owner and mode from the image.
RUN addgroup -S -g 10002 caddy \
 && adduser -S -D -H -u 10002 -G caddy -h /nonexistent -s /sbin/nologin caddy \
 && setcap -r /usr/bin/caddy \
 && chown root:root /usr/bin/caddy \
 && chmod 0755 /usr/bin/caddy \
 && test -z "$(getcap /usr/bin/caddy)" \
 && chown -R 10002:10002 /data /config \
 && chmod 0700 /data /config /data/caddy /config/caddy
COPY --chmod=0644 deploy/Caddyfile /etc/caddy/Caddyfile
USER 10002:10002
# Build-time check: the binary runs without capabilities and the Caddyfile adapts (adapting
# provisions nothing: no certificate or CA is written into the image).
RUN caddy version && caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
# CMD (caddy run --config /etc/caddy/Caddyfile --adapter caddyfile), WORKDIR /srv and the
# XDG_DATA_HOME=/data, XDG_CONFIG_HOME=/config environment come from the base image.
