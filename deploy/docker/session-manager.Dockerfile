# Termdock session-manager (data plane daemon). Build context: the repository root.
#   docker compose -f deploy/compose.yaml build session-manager
#
# The daemon runs its TypeScript sources directly (`node src/main.ts`, Node 24 type stripping).
# Node refuses to strip types under node_modules, so the runtime keeps the workspace layout
# (/app/apps/session-manager, /app/packages/*) with pnpm's symlinked node_modules, installed
# with production dependencies only. Dependency build scripts stay blocked (pnpm `allowBuilds`):
# better-sqlite3 loads its bundled prebuild; ssh2 falls back to pure-JS crypto.

# node:24-bookworm-slim (official Docker Hub image), pinned by digest.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
ENV CI=true
# pnpm at the exact version of the root package.json `packageManager` field; no install scripts.
RUN npm install --global --ignore-scripts pnpm@11.14.0 && npm cache clean --force
WORKDIR /src
# Manifests first: the dependency layer is reused until the lockfile or a manifest changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/session-manager/package.json apps/session-manager/
COPY packages/db/package.json packages/db/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY packages/terminal-config/package.json packages/terminal-config/
RUN --mount=type=cache,id=termdock-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store \
      --filter '@termdock/session-manager...'
COPY packages/db/src packages/db/src
COPY packages/db/drizzle packages/db/drizzle
COPY packages/protocol/src packages/protocol/src
COPY packages/shared/src packages/shared/src
COPY packages/terminal-config/src packages/terminal-config/src
COPY apps/session-manager/src apps/session-manager/src

# Same base image, pinned by the same digest.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
ENV NODE_ENV=production \
    TERMDOCK_DATA_DIR=/data
# Fixed non-root UID/GID shared with the web image (plan §10.2); npm, npx, corepack and yarn are
# not needed at runtime. /data is the only writable path besides the /tmp tmpfs.
RUN groupadd --system --gid 10001 termdock \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin termdock \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && install -d -o 10001 -g 10001 -m 0700 /data
# Application files stay owned by root: the daemon user can read them, never modify them.
COPY --from=build /src/node_modules /app/node_modules
COPY --from=build /src/packages /app/packages
COPY --from=build /src/apps/session-manager /app/apps/session-manager
# Smoke check at build time: the whole module graph resolves with production dependencies only,
# and the better-sqlite3 prebuild loads (main.ts only boots when run as the entry point).
RUN node --input-type=module -e "await import('/app/apps/session-manager/src/main.ts'); const { openDb } = await import('/app/packages/db/src/index.ts'); openDb(':memory:').\$client.close();"
WORKDIR /app/apps/session-manager
USER 10001:10001
# 3001: WebSocket attachments (edge network). 3002: internal API (internal network only).
EXPOSE 3001 3002
CMD ["node", "src/main.ts"]
