# syntax=docker/dockerfile:1
# The CKBolt hub as a container. Build context: the hub repo root (deploy/testnet/docker-compose.yml sets it), e.g.
#   docker build -f deploy/testnet/hub/Dockerfile -t ckbolt/hub:local .
# Dockerfile.dockerignore next to this file limits the context to what the build needs (no .env, data or devnet).
# Settings come from the environment (hub.env); the image holds no .env file. SQLite lives in the /data volume.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# better-sqlite3 installs a prebuilt binary; these tools build it from source when no prebuilt one matches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# package.json stays next to dist/: GET /v1/health reports its version.
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
# With HUB_PROXY_SECRET set the hub answers 401 without it, so the check sends it as the web app's proxy does.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "const s = process.env.HUB_PROXY_SECRET; fetch('http://127.0.0.1:' + (process.env.HUB_PORT || 8787) + '/v1/health', { headers: s && s.trim() ? { 'X-CKBolt-Proxy-Secret': s } : {} }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/main"]
