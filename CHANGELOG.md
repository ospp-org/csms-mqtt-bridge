# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No unreleased changes yet._

## [0.1.3] - 2026-04-28

### Documentation

- README: prominent caveat at the top of the "TLS SNI when connecting via
  an internal hostname" section noting that `MQTT_SERVERNAME` is currently
  ignored by `mqtt.js@5.15.1` due to an upstream bug at `connect/tls.js:28`
  (`opts.servername = opts.host` runs unconditionally for hostname targets,
  overwriting the user-provided value). Documents the Docker network alias
  workaround — set up an intra-Docker alias matching the broker cert SAN so
  the connect URL host already equals the SAN, and SNI defaulting to that
  host validates correctly without needing `MQTT_SERVERNAME`.
- Feature itself unchanged from 0.1.1. The variable is still plumbed
  through this bridge correctly; it will start working the day the
  upstream fix lands, with no code change required here. Kept as a
  dormant, forward-compatible knob rather than reverted.

### Notes

- No code changes. Documentation-only release for visibility into the
  upstream limitation discovered during csms-server compose integration
  (Phase 0.7b).

## [0.1.2] - 2026-04-28

### Changed

- `MQTT_CA_PATH` is now optional. When unset, mqtt.js falls back to Node's
  default TLS trust (system CA bundle), which is sufficient for brokers
  using publicly-trusted certificates (Let's Encrypt etc.). When set,
  behavior unchanged from 0.1.1 — the file is read and used as the CA
  trust anchor.
- `sanitizedConfigForLog` now omits `caPath` when `MQTT_CA_PATH` is unset
  (consistent with the `servername` handling introduced in 0.1.1).

## [0.1.1] - 2026-04-28

### Added

- `MQTT_SERVERNAME` optional env var for TLS SNI hostname override. Useful
  when connecting via an internal hostname (e.g. Docker network alias
  `emqx`) to a broker whose certificate SAN covers public hostnames
  (e.g. `mqtt-uat.onestoppay.ro`). When set, the value is forwarded to
  mqtt.js as `servername` and used as the SNI hostname in the TLS
  ClientHello; the TCP/TLS connection target itself is unchanged. When
  unset, behavior is identical to 0.1.0 (mqtt.js defaults SNI to the URL
  host).

## [0.1.0] - 2026-04-28

Initial OSPP MQTT bridge release. Covers AUDIT v2 phases 0.1 through 0.7a —
repo bootstrap, typed env-var loader, MQTT 5 client wrapper with mTLS and
shared subscriptions, Redis bridge with at-least-once delivery (manual-ack
inbound + BLMOVE outbound + startup replay), and the GHCR publish workflow
that produces this image.

### Added (Phase 0.7a — release tooling)

- `.github/workflows/release.yml` — multi-arch (`linux/amd64` +
  `linux/arm64`) Docker image publish to
  `ghcr.io/ospp-org/csms-mqtt-bridge` on every `v*.*.*` tag push. Tags
  emitted via `docker/metadata-action`: `vX.Y.Z`, `X.Y.Z`, `X.Y`,
  `sha-<short>`, and `latest`. SLSA provenance + SBOM attached at push
  time; build cached on the GitHub Actions cache backend (`type=gha`).
- Dockerfile OCI labels
  (`org.opencontainers.image.{source,description,licenses}`) baked into
  the runtime stage so locally-built images carry the same metadata as
  the published one. The release workflow's metadata-action overrides
  the same keys at push time and adds auto-derived `created` /
  `revision` labels.
- README "Deploying" section listing the published tag patterns and the
  `docker buildx imagetools inspect` recipe for verifying the multi-arch
  manifest.

### Added (Phase 0.5 — at-least-once delivery)

- Inbound manual ack via `client.handleMessage` override: PUBACK to the
  broker fires only after the inbound envelope is pushed to
  `mqtt:incoming`. On Redis failure the bridge calls back with an error,
  mqtt.js skips the PUBACK, and the broker re-delivers on session
  reconnect. Garbage topics are still acked-and-dropped (don't redeliver
  malformed messages forever).
- Outbound reliable consumption via `BLMOVE` into a new `mqtt:processing`
  list. After PUBACK the raw JSON is removed with `LREM`; if the bridge
  crashes between BLMOVE and PUBACK, the envelope stays in
  `mqtt:processing` and gets replayed on the next startup's first MQTT
  connect.
- `replayProcessing()` drains stuck items at startup. Successfully
  republished items are acked; failed publishes stay in processing for
  the next attempt. Malformed entries are LREM'd to keep the queue from
  growing unboundedly with garbage.
- `REDIS_QUEUE_PROCESSING` env var (default `mqtt:processing`).
- Redis lifecycle: `redis.start()` for explicit lazy connect, ioredis
  `retryStrategy` with exponential-backoff-plus-jitter capped at 30 s,
  structured logs on every state transition (`connect`/`ready`/
  `reconnecting`/`error`/`close`/`end`), plus a new
  `state.redisConnected` flag for future health checks.
- `src/__tests__/redis.test.ts` extended to cover `start()`,
  `pushIncoming`, `popOutgoingReliable` (BLMOVE + ack + malformed-entry
  cleanup), `replayProcessing` (parsing + LREM of bad items), and
  `quit()` (tolerating already-closed errors).
- `src/__tests__/mqtt.test.ts` updated for the new manual-ack path:
  `handleMessage` acks on success, propagates the error on Redis
  failure, and acks-and-drops on unrecognized topics. Outbound tests
  exercise BLMOVE + ack flow plus startup replay (idempotent across
  reconnects, no-op on empty processing, stuck-on-publish-failure path).
- Worker compatibility checklist in `docs/REDIS-QUEUE-CONTRACT.md`
  expanded with the at-least-once reality: csms-server's Phase 0.8
  worker MUST dedupe on `messageId` and MUST NOT touch
  `mqtt:processing`.
- Redis server requirements section in `docs/REDIS-QUEUE-CONTRACT.md` —
  version ≥ 6.2, AOF persistence, `noeviction` recommended (with note
  about UAT's `allkeys-lru` posture and the monitoring follow-up that
  Phase C will add).

### Changed (Phase 0.5)

- `RedisBridge` interface: `popOutgoing()` removed; replaced by
  `popOutgoingReliable()` returning `{ envelope, raw, ack }`. Callers
  invoke `ack()` only after the publish is confirmed by the broker.
- `createRedisBridge(config, client?)` signature widened to
  `createRedisBridge(config, opts?)` with `opts: { client?, logger? }`.
  The logger is wired up on internally-constructed clients to surface
  Redis lifecycle events.
- `src/index.ts` startup is now ordered: build Redis bridge → `await
  redis.start()` → start MQTT (which triggers replay on first connect).
  Shutdown is the reverse, bounded by `SHUTDOWN_TIMEOUT_MS`.
- `.env.example` `REDIS_URL` documented with `redis://[:password]@host`
  format; csms-server's compose runs Redis with `--requirepass`.

### Added (Phase 0.3–0.4 — config loader + MQTT client wrapper)

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

### Changed (Phase 0.3–0.4)

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

### Added (Phase 0.2 — scaffold)

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
  via mTLS. Round-trip latency was ~469 ms, no compatibility issues
  observed.
- Server certificate convention `csms-<env>-server-<N>` (e.g.
  `csms-uat-server-1`) — provisioning happens out-of-band via the
  `ospp:generate-server-cert` artisan command in csms-server (Phase 0.6).

[Unreleased]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ospp-org/csms-mqtt-bridge/releases/tag/v0.1.0
