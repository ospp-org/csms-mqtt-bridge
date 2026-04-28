# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `src/config.ts` — typed env-var loader using `zod` v4. Required vars
  (`MQTT_BROKER_URL`, `MQTT_CLIENT_ID`, `MQTT_*_PATH`, `REDIS_URL`) are
  validated at startup with file-existence checks for cert/key/CA paths and
  protocol checks (only `mqtt://`/`mqtts://` and `redis://`/`rediss://` are
  accepted). Optional vars carry sensible defaults (`LOG_LEVEL`, `METRICS_PORT`,
  `SHUTDOWN_TIMEOUT_MS`, MQTT keepalive/reconnect/connect timings, Redis
  queue keys + BLPOP timeout).
- `ConfigError` aggregates all validation issues into a single error so
  operators see every problem on first run instead of fixing them one at
  a time.
- `redactUrl` + `sanitizedConfigForLog` — log helpers that omit the private
  key path and redact userinfo from URL fields.
- `src/__tests__/config.test.ts` — 47 vitest cases covering happy paths,
  missing-required, invalid URL/number/enum/boolean, scheme validation,
  file existence, multi-issue reporting, redaction, and snapshot
  sanitization.
- `src/state.ts` — singleton bridge state (`mqttConnected`,
  `lastMessageReceivedAt`, `inflightOutbound`, `reconnectCount`) plus a
  `resetState()` helper used by tests.
- `src/redis.ts` — `RedisBridge` interface with `pushIncoming`,
  `popOutgoing`, `quit`, `isReady`. Includes a parser that rejects malformed
  outgoing envelopes before they reach the MQTT publish path. Phase 0.5
  will flesh out retries and structured validation.
- `src/mqtt.ts` — MQTT 5 client wrapper with mTLS, persistent session
  (`clean: false`), keepalive/reconnect/connect timings from config, LWT on
  `ospp/v1/server/status`, retained `online` status published on connect,
  shared subscription on `$share/ospp-servers/ospp/v1/stations/+/to-server`,
  outbound BLPOP loop that publishes envelopes from Redis with QoS 1, and a
  `stop()` that unsubscribes, publishes a retained `offline` status, drains
  the outbound loop, and ends the client gracefully.
- `src/__tests__/mqtt.test.ts` — 25 vitest cases covering topic parsing,
  client option construction, connect/subscribe/online-publish flow,
  state transitions on connect/close/offline/reconnect, inbound envelope
  shape and base64 round-trip, drop on unexpected topics, redis-push
  failure resilience, outbound publish, malformed-envelope back-off, and
  `stop()` semantics for both connected and never-connected paths.
- `.env.example` — documented placeholder values for every variable.
- `.prettierignore` — keeps `docs/`, `CHANGELOG.md`, and lockfile out of
  Prettier's scope.
- `tsconfig.build.json` — split out from `tsconfig.json` so the build excludes
  `*.test.ts` and `__tests__/` while typecheck still covers them.

### Changed

- `src/index.ts` wires up config → Redis bridge → MQTT bridge with explicit
  shutdown handling: SIGTERM/SIGINT call `mqtt.stop()` then `redis.quit()`,
  guarded by a `SHUTDOWN_TIMEOUT_MS` deadline that forces exit if cleanup
  hangs; logs an explicit `INSECURE: TLS server cert validation disabled`
  warning when `MQTT_REJECT_UNAUTHORIZED=false`.
- `package.json` `build` script now uses `tsc -p tsconfig.build.json`.
- `Dockerfile` builder stage copies both tsconfig files.
- `README.md` env-var section replaced with full required/optional tables;
  Status section now shows the Phase 0 progress matrix.

### Dependencies

- Added: `zod ^4.3.6` (config validation).

## [0.1.0] - 2026-04-28

Initial scaffold per AUDIT v2 §0.2 (Phase 0 work item: Repo bootstrap).
No business logic yet — Phase 0.3-0.5 will add config loader, MQTT client
wrapper, and Redis bridge on top of this foundation.

### Added

- `package.json` with strict dependency set: `mqtt@^5`, `ioredis@^5`,
  `pino@^9`, `prom-client@^15` (runtime); `typescript@^5`, `vitest@^2`,
  `eslint@^9`, `typescript-eslint@^8`, `prettier@^3`, `tsx@^4` (dev).
- `tsconfig.json` — TypeScript strict mode (all strict flags), ES2022 target,
  NodeNext module resolution, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`.
- `eslint.config.js` — ESLint 9 flat config with `typescript-eslint` strict
  type-checked + stylistic rules; explicit `no-floating-promises`,
  `require-await`, `prefer-nullish-coalescing`, `prefer-optional-chain`.
- `prettier.config.js` — 2-space, single quotes, trailing commas all,
  100-char width.
- `Dockerfile` — multi-stage (deps / builder / runtime) on `node:22-alpine`,
  `tini` as PID 1, runs as `node` user. Final image targets <100 MB.
- `.dockerignore`, `.editorconfig`, `.github/workflows/ci.yml`.
- GitHub Actions CI runs lint + typecheck + test + build on push and PR.
- `src/index.ts` — minimal placeholder with `pino` logger and SIGTERM/SIGINT
  graceful shutdown hooks. Replaced in Phase 0.3.
- `README.md` — architecture diagram (ASCII), env-var placeholder table,
  build/run instructions, OSPP spec reference.

### Notes

- Phase 0.1 POC validated `mqtt@5` + Node 22+ against the UAT EMQX broker
  via mTLS. Round-trip latency was ~469ms, no compatibility issues observed.
- Server certificate convention `csms-<env>-server-<N>` (e.g.
  `csms-uat-server-1`) — provisioning happens out-of-band via the
  `ospp:generate-server-cert` artisan command in csms-server (Phase 0.6).

[Unreleased]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ospp-org/csms-mqtt-bridge/releases/tag/v0.1.0
