# AI Creator Studio — single-container image.
#
#   docker compose up
#
# The app self-seeds on first boot and stores its database and generated assets
# under /data, which docker-compose mounts as a named volume so your work
# survives restarts.

# ---- deps: install with the native better-sqlite3 build toolchain -----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 compiles from source when no prebuilt binary matches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: produce the standalone server bundle ---------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data

# Placeholder providers by default, so the container is useful with no keys.
# Add real keys on the Settings page (or override these) to go live.
ENV IMAGE_PROVIDER=mock \
    VIDEO_PROVIDER=mock \
    VOICE_PROVIDER=mock \
    LLM_PROVIDER=mock

# The standalone bundle already has `.next/static` (and `public/`, on a project
# that has one) folded in by the postbuild step, so one copy is the whole app.
# The previous version copied `/app/public` separately and unconditionally,
# which fails the image build outright here: this project has no `public/`.
COPY --from=build /app/.next/standalone ./

# Run unprivileged, and make /data writable by that user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3000

# Fail the container's health check if the app stops answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
