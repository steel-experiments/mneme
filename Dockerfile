# Mneme production image (Section 38).
#
# Multi-stage build: the build stage installs dependencies, compiles TypeScript,
# and prunes dev dependencies; the runtime stage copies only what the application
# needs and runs as the unprivileged `node` user under `tini` for proper PID 1 /
# signal handling. Mutable state lives only under /app/data.
FROM node:24.21-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY prompts ./prompts
COPY docs ./docs
COPY config ./config

RUN npm run build \
    && npm prune --omit=dev

FROM node:24.21-bookworm-slim AS runtime

# Recorded source revision (Section 38.7). The release workflow passes the git
# SHA of the tagged release. Empty in local builds; build-info treats an empty
# value as unset and falls back.
ARG MNEME_SOURCE_REVISION=""
ENV NODE_ENV=production \
    HOME=/tmp \
    PORT=3000 \
    DATA_DIR=/app/data \
    DATABASE_PATH=/app/data/mneme.sqlite \
    PROMPT_DIR=/app/prompts \
    DOCS_DIR=/app/docs \
    MNEME_CONFIG_PATH=/app/config/mneme.yml \
    CHANNEL_POLICY_PATH=/app/config/channel-policy.yml \
    MNEME_SOURCE_REVISION=${MNEME_SOURCE_REVISION}

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/prompts ./prompts
COPY --from=build /app/docs ./docs
COPY --from=build /app/config ./config

COPY docker/entrypoint.sh /usr/local/bin/mneme-entrypoint
RUN chmod 0755 /usr/local/bin/mneme-entrypoint \
    && mkdir -p /app/data \
    && chown -R node:node /app

EXPOSE 3000

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]

ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/mneme-entrypoint"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
