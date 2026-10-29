# payzeno-api
#
# Build context is the pnpm workspace ROOT, not this directory — payzeno-api depends on
# payzeno-contracts via `workspace:*` and cannot install without it. docker-compose.yml
# in payzeno-infrastructure sets `context: ..` for exactly this reason.
#
#   docker build -f payzeno-api/Dockerfile -t payzeno/api:local .
#
# argon2 has a native build step, hence the toolchain in the deps stage and the
# separate runtime stage that does not carry it.

# ---------- deps ----------
FROM node:20.11-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.1.1 --activate
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY payzeno-contracts/package.json payzeno-contracts/package.json
COPY payzeno-api/package.json       payzeno-api/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @payzeno/api...

# ---------- build ----------
FROM deps AS build
WORKDIR /repo
COPY payzeno-contracts payzeno-contracts
COPY payzeno-api       payzeno-api
RUN pnpm --filter @payzeno/contracts build \
 && pnpm --filter @payzeno/api build
# A self-contained copy of the api with production deps only, and the contracts package
# materialised as real files rather than a workspace symlink. Copying the workspace's
# node_modules into another layout does not work: pnpm's links are relative, and they
# resolve to nothing once moved.
RUN pnpm --filter @payzeno/api --prod deploy /deploy

# ---------- runtime ----------
FROM node:20.11-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

COPY --from=build /deploy/node_modules                     /app/node_modules
# `deploy` packs the way a publish would, and dist/ is gitignored, so the build output comes
# straight from the build stage.
COPY --from=build /repo/payzeno-api/dist                   /app/dist
COPY --from=build /deploy/package.json                     /app/package.json
COPY --from=build /deploy/contracts                        /app/contracts

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin payzeno \
 && chown -R payzeno:payzeno /app
USER payzeno

EXPOSE 8080

# ECS/ALB use /readyz (checks pg + redis + ledger). This one is the liveness probe and
# deliberately touches nothing downstream — see docs/runbooks/payzeno-api.md.
HEALTHCHECK --interval=15s --timeout=3s --start-period=25s --retries=4 \
  CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# instrumentation.ts is imported first inside main.ts, so OTel patches before Nest boots.
CMD ["node", "dist/main.js"]
