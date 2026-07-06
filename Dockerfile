# Standalone happy-server: single container, no external dependencies
# Uses PGlite (embedded Postgres), local filesystem storage, no Redis

# Stage 1: install dependencies
FROM node:24 AS deps

RUN apt-get update && apt-get install -y python3 make g++ build-essential && rm -rf /var/lib/apt/lists/*
RUN npm install -g bun@1.3.14

WORKDIR /repo

COPY package.json bun.lock bunfig.toml ./
COPY scripts ./scripts
COPY patches ./patches

# bun's workspaces list is explicit paths — every workspace package.json must
# exist or install fails to resolve the workspace graph.
RUN mkdir -p packages/happy-app packages/happy-server packages/happy-cli packages/happy-agent packages/happy-wire packages/happy-app-logs packages/codium

COPY packages/happy-app/package.json packages/happy-app/
COPY packages/happy-server/package.json packages/happy-server/
COPY packages/happy-cli/package.json packages/happy-cli/
COPY packages/happy-agent/package.json packages/happy-agent/
COPY packages/happy-wire/package.json packages/happy-wire/
COPY packages/happy-app-logs/package.json packages/happy-app-logs/
COPY packages/codium/package.json packages/codium/

# Workspace postinstall requirements
COPY packages/happy-app/patches packages/happy-app/patches
COPY packages/happy-server/prisma packages/happy-server/prisma
COPY packages/happy-cli/scripts packages/happy-cli/scripts
COPY packages/happy-cli/tools packages/happy-cli/tools

RUN SKIP_HAPPY_WIRE_BUILD=1 bun install --frozen-lockfile

# Stage 2: copy source and type-check
FROM deps AS builder

COPY packages/happy-wire ./packages/happy-wire
COPY packages/happy-server ./packages/happy-server

RUN bun run --filter @slopus/happy-wire build
RUN bun run --filter happy-server build

# Stage 3: runtime
FROM node:20-slim AS runner

WORKDIR /repo

RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PGLITE_DIR=/data/pglite

COPY --from=builder /repo/node_modules /repo/node_modules
COPY --from=builder /repo/packages/happy-wire /repo/packages/happy-wire
COPY --from=builder /repo/packages/happy-server /repo/packages/happy-server

VOLUME /data
EXPOSE 3005

WORKDIR /repo/packages/happy-server

CMD ["sh", "-c", "../../node_modules/.bin/tsx sources/standalone.ts migrate && exec ../../node_modules/.bin/tsx sources/standalone.ts serve"]
