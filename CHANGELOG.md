# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Documentation

- `docs/REDIS-QUEUE-CONTRACT.md`: "Reliability semantics" no longer says the bridge is
  at-least-once "in both directions as of Phase 0.5". It carries one direction since 0.2.0,
  inbound - the section's only subsection - and what the application sends goes over the EMQX
  REST API.
- The station id bound `stn_[a-f0-9]{8,60}` is the spec's as well as csms-server's: the
  contract's `topic` member credited it to `01-architecture.md` section 3.1, which states
  `^stn_[a-f0-9]{8,}$` with no upper bound, and the comment above `STATION_TOPIC_RE` in
  `src/mqtt.ts` said the spec sets none. The 60 is the spec's station-id schema's `maxLength`
  of 64, less `stn_`; both now say so.
- README: the repository layout lists the tracked tree. It still showed the initial
  scaffold - `src/index.ts` as a placeholder, `ci.yml` as the only workflow - and none of
  the other `src/` modules, `docs/` or `release.yml`.
- `src/index.ts` no longer says that stopping MQTT drains outbound - the outbound path went
  in 0.2.0 - nor that the MQTT client is constructed only over a queue Redis proven
  non-evicting. With `REDIS_REQUIRE_NOEVICTION=false` it is constructed after a warning
  when the policy is not `noeviction` or cannot be read.
- The OSPP spec is cited by section heading instead of by line, in the README,
  `package.json` and `src/mqtt.ts`: four of the five places cited no longer held the
  cited text at v0.44.0. Two of the sections, "3.2 MQTT Setup" and the "Server Core"
  conformance checklist, ask for a shared subscription; the README now says the bridge
  holds a plain one, and `package.json` cites only "The Three Actors".
- README, `package.json` and `docs/REDIS-QUEUE-CONTRACT.md` said "Redis queues". There has
  been one since 0.2.0 - `REDIS_QUEUE_INCOMING`, whose only writer is `pushIncoming` - so each
  now says "a Redis queue".
- README: the opening no longer says the CSMS application "communicates with stations
  exclusively through this sidecar". Station messages reach csms-server through it
  (`MqttConsume` reads `mqtt:incoming`); what the application sends goes through
  `MqttStationGateway` and `EmqxApiPublisher` to the EMQX REST API, as the Architecture
  section already said.
- `src/health.ts`: the comment on `redisReady` no longer says "Both ioredis clients report
  ready". `isReady()` has read one client since 0.2.0 removed the dedicated blocking one; the
  comment was true when `/healthz` was written and went stale with that removal.
- The mqtt.js SNI bug is named by function, not by line. The README and the 0.1.3 and 0.1.4
  entries below put it at a line of `connect/tls.js`; it is `buildStream` in that file, where
  at mqtt.js 5.15.1, the pinned version, `opts.servername = opts.host` runs for every host
  that is not an IP literal, overwriting the `servername` the bridge passes.
- `src/config.ts`, a comment in `src/__tests__/mqtt.test.ts` and `docs/REDIS-QUEUE-CONTRACT.md`
  cite by name, not by line: the spec's `02-transport.md` section 1.2 Connection Parameters and
  `01-architecture.md` section 3.1 Identifier Format, and csms-server's
  `MessageDispatcher::dispatch()` and `MessageFactory::fromJson()`, whose deduplication
  statements have since moved within their files.
- `docs/ADR-0001-outbound-path-removed.md`: its 12 line citations are names of what the lines
  held on 2026-08-18, the ADR's date - csms-server at `e12b10e7`, the spec at v0.23.0. The
  ADR's claims are unchanged.
- `docs/AUDIT-UAT-PROD-MIRROR.md`, the frozen v2 audit: its 15 line citations are names of what
  the lines held on 2026-04-27 - csms-server at `b261c789`, the spec at v0.2.4. The audit's
  claims are unchanged.
- `docs/AUDIT-MQTT-BRIDGE.md`: 168 of its 169 line citations are names of what the lines held
  when it was measured on 2026-08-18 - the bridge at `2ba00e8`, csms-server at `d8c595b6`,
  mqtt.js 5.15.1. The one left as written is the local-dev `docker-compose.override.yml` row
  of the deployment table: csms-server never tracked that file, so there is no commit to
  resolve it against. The audit's claims are unchanged.

### Internal

- The CI workflow's job times out after **20 minutes** instead of GitHub's default 360, as
  the release job has since 0.2.1. It runs in under a minute: 16 to 51 seconds over its 20
  runs up to v0.2.1. A test now requires a job-level `timeout-minutes` below 360 on every
  job of every workflow.
- The scrape-time state gauges test is titled for what it asserts, the MQTT and Redis
  connection state and the reconnect count. Its title still named the in-flight count that
  went with the outbound path in 0.2.0.

## [0.2.1] - 2026-09-29

### Fixed

- **The startup line no longer claims a durability the check did not find.** With
  `REDIS_REQUIRE_NOEVICTION=false` and a queue Redis whose `maxmemory-policy` is not
  `noeviction`, or cannot be read, the bridge logged its `[QUEUE_DURABILITY]` warning and
  then `queue durability asserted (maxmemory-policy=noeviction)` - the opposite of the
  warning just before it. That line is now logged only when the policy is `noeviction`;
  otherwise a warn-level `queue durability NOT asserted (maxmemory-policy=<policy>)` names
  the policy and the downgrade, and startup goes on as before. `assertQueueDurable()`
  resolves with what it found (`{ durable, policy }`) instead of `undefined`, which both
  branches used to resolve. The refusal itself, the warning and
  `csms_bridge_queue_durability_violations_total` are unchanged.

### Documentation

- README: the `GET /metrics` table listed `csms_bridge_inflight_outbound`, which went with
  the outbound path in 0.2.0 and which nothing registers. The row is removed, and a test
  pins the table to the bridge registry both ways, on name, type and labels.
- `src/bootstrap.ts` no longer says an outbound loop needs the Redis connection, and cites
  the csms-server report on the startup order by its heading instead of by line range.

### Internal

- The release workflow's job times out after **20 minutes** instead of GitHub's default
  360. The first v0.2.0 release attempt hung in the arm64 `npm ci` under QEMU
  (`Illegal instruction`) and printed nothing for 58 minutes until it was cancelled by
  hand; a release normally publishes in about 3.

## [0.2.0] - 2026-09-29

### Removed

- **The Redis outbound path, in full** — the `BLMOVE` loop, `mqtt:processing`, the
  startup replay, `parseOutgoingEnvelope`, the `OutgoingEnvelope` and
  `ReliableOutgoing` types, `REDIS_QUEUE_OUTGOING` / `REDIS_QUEUE_PROCESSING` /
  `REDIS_BLPOP_TIMEOUT_SEC`, `state.inflightOutbound`, the dedicated `duplicate()`
  ioredis client, and **47 tests** (198 → 151). No producer ever existed in
  csms-server; server→station goes over the EMQX REST API. The types went too because
  the schema had no `retain` field the server passes on every publish — it could not
  have carried today's traffic. See
  [ADR-0001](./docs/ADR-0001-outbound-path-removed.md), which also records the
  still-OPEN "not OSPP-compliant" verdict on the REST publisher, and the deliberate
  divergence from the spec's SHOULD on shared subscriptions.

### Added

- **The inbound grant is read.** After each SUBSCRIBE the SUBACK is checked: a refusal
  (a reason code with the `0x80` bit - `135` Not authorized is what an ACL deny answers)
  or a grant below the QoS 1 asked is logged at `fatal` and the bridge exits **1**. It
  used to log the refusal and run on subscribed to nothing, and to log a QoS 0 grant as
  a success - at QoS 0 the broker queues nothing for the persistent session and waits
  for no PUBACK, so the manual ack guarded nothing. A SUBSCRIBE cut off by a closing
  connection is not a refusal. `startMqttClient` takes the connector and an `onFatal`
  handler as required arguments.
- **A stuck bridge exits** (`src/watchdog.ts`), so the container's restart policy
  restarts it - a health check restarts nothing. Three conditions, each logged as
  `bridge is stuck` with the condition before an exit **1**: `mqtt_down` (the broker
  connection down past `WATCHDOG_MQTT_DOWN_MS`, default 120 s, a broker never reached
  counting), `inbound_stalled` (one message in hand past `WATCHDOG_INBOUND_STALL_MS`,
  default 60 s - a Redis push that never settles), and `unacked_pending` (a refused push
  left unacknowledged past the same limit - the broker resends it only on a new
  connection). A restart loses nothing: the session is persistent and nothing stuck was
  acknowledged. Proven at process level by `watchdog.integration.test.ts`.
- **`assertQueueDurable()`** — the bridge refuses to start when the queue Redis
  reports a `maxmemory-policy` other than `noeviction`. Under an eviction policy an
  `LPUSH` reports success, the bridge PUBACKs, the broker drops its copy, and Redis
  discards the entry: measured 400 pushes → 400 acked, 16 surviving. Fails **closed**
  on an undeterminable policy. New `REDIS_REQUIRE_NOEVICTION`, default `true`.
- **`src/bootstrap.ts`** — genuinely ordered startup: `start()` →
  `assertQueueDurable()` → only then the MQTT client. A refusal is only safe if
  nothing was accepted first. The documented ordering was previously not implemented.
- **`src/health.ts`** — `/healthz` returns **503** unless the bridge holds a broker
  connection *and* Redis is ready, with a JSON body naming the failing leg. It
  previously returned 200 unconditionally. `HEALTHCHECK` added to the image.
- **Metrics**: `csms_bridge_build_info{version}`,
  `csms_bridge_inbound_push_failures_total`,
  `csms_bridge_queue_durability_violations_total{policy}`, and gauges for every
  `state.ts` field, collected at scrape time.
- **Integration test against a real Redis** (`eviction.integration.test.ts`), run by
  CI against a redis service, with an anti-vacuity guard and a case that fails the
  build if it is ever silently skipped.

### Fixed

- `docs/REDIS-QUEUE-CONTRACT.md` told consumers to dedupe on the envelope
  `messageId`, which the bridge regenerates on every delivery — so in the very
  re-delivery scenario it named, it could never match. Corrected to the OSPP
  `messageId` inside the payload, which is what csms-server always used.
- Stale mechanics across the contract, README and `package.json`: `$share/`
  subscription, `BLPOP`, `BRPOP`, "Horizon worker".

## [0.1.4] - 2026-05-16

### Changed

- `src/index.ts` startup log: replaced stale `phase: '0.5'` field with
  `version: <package-version>` read from `package.json` at module load
  (ESM-safe `import.meta.url` + `readFileSync`). The phase tag was
  introduced in `a837492` (Phase 0.5) and never updated through Phases
  0.6, 0.7a, 0.7a-1, 0.7b, 0.7c — operators were seeing a stale marker.
  Version field now auto-updates with each release.

### Internal

- Removed unused `export` keyword from 5 module-internal symbols
  (`handleInbound` in `mqtt.ts`; `Qos`, `EnvelopeVersion`,
  `CreateRedisBridgeOpts` in `redis.ts`; `BridgeState` in `state.ts`).
  All five were used inside their own module but never imported by
  another module — the `export` was unused API surface. No public API
  change. Tests exercise `handleInbound` indirectly via the
  `handleMessage` override and required no changes.

### Documentation

- README: removed broken placeholder link to upstream `mqtt.js` issue
  (decision: not filing upstream — the Docker network alias workaround
  is the permanent solution). The surrounding caveat already cites the
  upstream bug location (`buildStream` in `connect/tls.js`) and explains the limitation.

## [0.1.3] - 2026-04-28

### Documentation

- README: prominent caveat at the top of the "TLS SNI when connecting via
  an internal hostname" section noting that `MQTT_SERVERNAME` is currently
  ignored by `mqtt.js@5.15.1` due to an upstream bug in `buildStream` in `connect/tls.js`
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

[Unreleased]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.7...v0.2.0
[0.1.4]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ospp-org/csms-mqtt-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ospp-org/csms-mqtt-bridge/releases/tag/v0.1.0
