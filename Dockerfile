# ------------------------------------------------
# Stage 1: Build the TypeScript application

FROM node:22 AS builder

WORKDIR /app

COPY package*.json ./

# npm ci (not npm install): installs exactly what package-lock.json pins,
# so the image is reproducible and a drifted lock file fails the build
# instead of silently resolving newer versions.
RUN npm ci

COPY . .

RUN npx tsc

# ------------------------------------------------
# Stage 2: Create the final image

FROM node:22

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# npm ci --omit=dev (not npm install): production deps exactly as pinned in
# the lock file (copied above), no dev dependencies in the runtime image.
RUN npm ci --omit=dev && npm cache clean --force

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

# Create configs directory with write permissions
RUN mkdir -p /app/configs && chown -R appuser:appgroup /app/configs

USER appuser

# Internal API port: 3301 must stay in sync with config.yml's `apiPort`, the
# application's source of truth. config.yml is a mounted file the baked image
# cannot read at build time, so there is no single source of truth across the
# file and the image — three places hardcode it (an intentional, documented
# constraint, not a bug; see CLAUDE.md, "Configuration Options"):
#   EXPOSE (below)         informational only
#   HEALTHCHECK (below)    probes localhost:3301/health
#   compose "3301:3301"    host -> container mapping (docker-compose.yml)
# Changing apiPort means editing all three to match, or the healthcheck fails
# and the host port never reaches the service.
EXPOSE 3301

WORKDIR /app/dist

# Health check - polls the /health endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3301/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
