# Termavox web (Next.js control plane). Build context: the repository root.
#   docker compose -f deploy/compose.yaml build web
#
# Next.js `output: 'standalone'` (apps/web/next.config.ts) traces the server's runtime files from
# the monorepo root, so the runtime image carries only the traced server, its node_modules
# subset (including the better-sqlite3 prebuild) and the static assets.

# node:24-bookworm-slim (official Docker Hub image), pinned by digest.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1
# pnpm at the exact version of the root package.json `packageManager` field; no install scripts.
RUN npm install --global --ignore-scripts pnpm@11.14.0 && npm cache clean --force
WORKDIR /src
# Manifests first: the dependency layer is reused until the lockfile or a manifest changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/session-manager/package.json apps/session-manager/
COPY packages/db/package.json packages/db/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY packages/terminal-config/package.json packages/terminal-config/
# The full workspace install (dev dependencies included): `next build` type-checks with the root
# typescript and @types/node, and compiles CSS with Tailwind.
RUN --mount=type=cache,id=termavox-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @termavox/web build

# Same base image, pinned by the same digest.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    TERMAVOX_DATA_DIR=/data
# Fixed non-root UID/GID shared with the session-manager image (plan §10.2); npm, npx, corepack
# and yarn are not needed at runtime. Writable paths: /data (volume), /tmp and .next/cache (tmpfs).
RUN groupadd --system --gid 10001 termavox \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin termavox \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && install -d -o 10001 -g 10001 -m 0700 /data
WORKDIR /app
# Application files stay owned by root: the web user can read them, never modify them.
COPY --from=build /src/apps/web/.next/standalone ./
COPY --from=build /src/apps/web/.next/static ./apps/web/.next/static
# Smoke check at build time: the traced better-sqlite3 (a server external, linked from
# .next/node_modules) loads its native prebuild.
RUN install -d -o 10001 -g 10001 -m 0700 apps/web/.next/cache \
 && node -e "const fs = require('node:fs'); const dir = 'apps/web/.next/node_modules'; const name = fs.readdirSync(dir).find((n) => n.startsWith('better-sqlite3')); if (!name) throw new Error('better-sqlite3 was not traced'); const Database = require('./' + dir + '/' + name); new Database(':memory:').close();"
USER 10001:10001
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
