FROM node:22-alpine AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
# Production: no dev netsim (NETSIM) unless NETSIM_ALLOW=1, lean Express errors
ENV NODE_ENV=production
# Persistent state (resume-ticket secret, later the SQLite leaderboards);
# mount a volume here so it survives redeploys. docs/ops.md
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data
COPY package*.json ./
RUN npm ci --omit=dev
# dist/server + dist/shared (tsc) and dist/client (Vite build incl. public/)
COPY --from=builder /app/dist ./dist
EXPOSE 8000
# /healthz answers 503 when the tick has stalled for a second and not at all
# when the event loop hangs; Swarm (Dokploy) replaces an unhealthy task.
# BusyBox wget is part of the Alpine image. docs/ops.md
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-8000}/healthz" > /dev/null || exit 1
# Node runs as PID 1 and handles SIGTERM itself: clients get a 'shutdown'
# with a resume ticket, then the process exits with 0 (docs/phase-1b-design.md, 11.2)
STOPSIGNAL SIGTERM
CMD ["node", "dist/server/index.js"]
