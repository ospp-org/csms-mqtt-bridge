# syntax=docker/dockerfile:1.7

# Pin to immutable digest (SHA256) for reproducible builds + supply-chain
# defense against tag mutation. Bump manually for security patches; future
# Phase F can automate via Renovate/Dependabot.
# As of 2026-04-28, this digest tracks node:22.22.2-alpine.
ARG NODE_IMAGE=node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f

# ---- Stage 1: production-only dependencies ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Stage 2: build (all deps + tsc) ----
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Stage 3: runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tini for proper signal handling (PID 1) — graceful SIGTERM
RUN apk add --no-cache tini

COPY --from=deps    --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist         ./dist
COPY              --chown=node:node package.json LICENSE ./

USER node

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
