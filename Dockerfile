# syntax=docker/dockerfile:1.7

# ---- Stage 1: production-only dependencies ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- Stage 2: build (all deps + tsc) ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 3: runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tini for proper signal handling (PID 1) — graceful SIGTERM
RUN apk add --no-cache tini

COPY --from=deps    --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist         ./dist
COPY              --chown=node:node package.json LICENSE ./

USER node

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
