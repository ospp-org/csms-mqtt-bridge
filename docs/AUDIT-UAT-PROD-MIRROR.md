# AUDIT — UAT prod-mirror alignment (v2)

**Date**: 2026-04-27
**Version**: 2 (revised after CLI PASUL A verification + OSPP spec re-read)
**Scope**: CSMS server UAT environment at api-uat.onestoppay.ro / mqtt-uat.onestoppay.ro:8884
**Goal**: align UAT to be a true prod-mirror so that what passes UAT works in prod, and prod can be deployed with confidence. **Aligned with OSPP spec — no shortcuts.**

---

## 0. Framing — read this first

UAT was originally configured as a dev-friendly environment to unblock frontend/API iteration. That decision left UAT functionally usable but **not** representative of how prod will behave. The risk: prod has never been deployed; its config files exist but have never run end-to-end.

This audit (v2) identifies the gaps between UAT-actual and UAT-as-prod-mirror, and includes the major architectural addition discovered during PASUL A verification: **csms-server must be an MQTT client subscriber** (per OSPP spec `implementors-guide.md:48,227,626,1150`), not just an HTTP webhook receiver. The current implementation uses webhook + EMQX REST API publish — a sandbox shortcut, not OSPP-compliant. Phase 0 introduces a proper MQTT subscriber as a Node.js sidecar.

User principle (do not violate): **"There is no 'correct for now' solution. Either a solution is correct or it isn't."**

---

## 0.5. Decisions taken — NOT to be re-opened

The following are settled. Implementer (Claude CLI) may flag if any decision appears clearly wrong on technical grounds, but should NOT explore alternatives:

1. **Authentication architecture**: pure mTLS, no MqttAuthController/MqttAclController. CN extracted from cert via `peer_cert_as_clientid = cn` is the MQTT clientid. File ACL with `${clientid}` substitution provides per-station topic isolation. Final.

2. **MQTT transport for csms-server**: server is a real MQTT client. Implementation is a **Node.js sidecar service** (`csms-mqtt-bridge`) using `mqtt.js`. It subscribes to `$share/ospp-servers/ospp/v1/stations/+/to-server` (shared subscription per OSPP spec implementors-guide.md:626) and publishes to `ospp/v1/stations/{id}/to-station`. Communicates with PHP application via Redis (push-pull queues). Final. Webhook + EMQX REST API publish is **legacy**, will be deprecated and removed after sidecar is stable.

3. **Server cert CN convention**: `csms-uat-server-N` (UAT) and `csms-prod-server-N` (prod), where N is instance number for horizontal scaling. ACL pattern `csms-server-*` matches both. Server cert signed by Station CA (treat server as a privileged "station" identity at PKI level — same trust chain).

4. **Root CA placement for EMQX**: copy manually now (Phase A.2). Init container automation deferred to Phase F.

5. **Secrets management**: bind-mount `.env` into container (Phase B.2). Real vault deferred to Phase F.

6. **Backups**: cron on host, not Laravel scheduler. Decouples backups from app uptime. (Phase D.3)

7. **Admin endpoint for provisioning-tokens**: ADD NOW in Phase E. Without it, onboarding requires SQL access — unacceptable for prod. Implementation in §E.4.

8. **EMQX REST API admin password**: critical secret. Phase B verifies it's not baked in image. After sidecar is stable (Phase 0 done), REST API admin password becomes irrelevant for runtime — only used for emqx-init webhook setup, not for application publish.

9. **Implementation order**: 0 → A → B → E → C → D. Phase 0 first so csms-server speaks proper MQTT. Phase A then aligns EMQX security to match. B short, completes security baseline. E delivers admin provisioning UX. C/D last.

---

## 1. Current state — verified by CLI PASUL A

### 1.1 What exists and works

- `csms-server` repository on master branch, clean. Latest commits: `0b145eb` (CN provisioning fix), `b261c78` (deploy script branch fix). Both deployed to UAT.
- Full admin API in `routes/api/v1/admin.php`:
  - `POST /api/v1/admin/stations` (StationManagementController::registerStation, rbac:platform_admin)
  - `POST /api/v1/admin/stations/{id}/install-certificate`
  - `POST /api/v1/admin/stations/{id}/trigger-cert-renewal`
  - Plus 13 other lifecycle endpoints.
- Internal routes in `routes/internal.php`:
  - `POST /internal/mqtt/webhook` → `MqttWebhookController` with `VerifyEmqxWebhook` middleware
  - Webhook secret read from `config('mqtt.webhook.secret')` → `env('EMQX_WEBHOOK_SECRET')`. **Single env var name** — confirmed by CLI.
- Provisioning endpoint `POST /api/v1/provisioning` in `app/Http/Controllers/Api/V1/ProvisioningController.php`. CSR validation fixed for single-prefix CN.
- `RegisterStationRequest` (not `StoreStationRequest` — corrected by CLI). Body shape: `stationId`, `stationModel`, `stationVendor`, `locationId`, `bays[]`.
- Database schema designed for pure-mTLS: `stations` has `ecdsa_public_key`, `cert_serial_number`, `cert_expires_at`, `session_key_hash`. **No `mqtt_username` or `password` columns**.
- `provisioning_tokens` table: token = SHA-256 hash, `used_at` for single-use enforcement.
- EMQX webhook pipeline active on UAT: connector `csms_webhook` (status `connected`), action `csms_mqtt_webhook`, rule `csms_mqtt_forward`. `init-webhook.sh` idempotent.
- Storage keys present: jwt, root-ca-cert.pem (P-384, 20-year), root-ca-key.enc.json, station-ca-cert.pem (P-256, 5-year), station-ca-key.enc.json. AES-256-GCM master key in `.env`.
- One station (`stn_00000001`) provisioned end-to-end. Cert valid, chain validates, DB row in `certificates` confirms.
- **Health endpoints implemented** (CLI verified): `HealthCheckController` does `/health`, `/health/ready`, `/health/live` complete (DB + Redis + MQTT checks). Loaded via `bootstrap/app.php:21`.
- **Metrics endpoint implemented** (CLI verified): `MetricsController` + `App\Shared\Observability\PrometheusMetrics`, route in `routes/health.php:23`. Promphp wrapped.

### 1.2 What is broken or missing

| # | Issue | Severity | Phase | Location |
|---|---|---|---|---|
| 1 | csms-server is NOT an MQTT client subscriber (uses webhook + EMQX REST API publish; OSPP spec requires MQTT subscriber per implementors-guide.md:48,626) | CRITICAL | 0 | New service required |
| 2 | EMQX `verify = verify_none` on UAT (env override hides config) | CRITICAL | A | `docker-compose.yml` line 109 (BASE compose) |
| 3 | EMQX `fail_if_no_peer_cert = false` on UAT (env override) | CRITICAL | A | `docker-compose.yml` line 110 (BASE) |
| 4 | EMQX `cacertfile` points to wrong CA (currently dev/Let's Encrypt; should be OneStopPay Root CA — client cert trust anchor) | CRITICAL | A | `docker/emqx/emqx.conf` line 41 + cert mount |
| 5 | EMQX missing `peer_cert_as_clientid = cn` directive | CRITICAL | A | `emqx.conf` and `.production` both |
| 6 | EMQX file ACL has `{allow, all}` catch-all + `no_match = allow`; production variant correct but never mounted | HIGH | A | `docker/emqx/acl.conf` + `emqx.conf` |
| 7 | `EMQX_WEBHOOK_SECRET` is empty string — webhook unauthenticated (transitional issue, removed when webhook is deprecated in Phase 0) | HIGH | A | compose env |
| 8 | `.env` is bake-included in Docker image | CRITICAL | B | `.dockerignore` |
| 9 | `routes/metrics.php` orphan (closure not loaded by bootstrap; real metrics live in `routes/health.php:23`) | LOW | C | route file cleanup |
| 10 | Loki up but Laravel logs not shipped | MEDIUM | C | logging driver |
| 11 | No backup schedule | MEDIUM | D | host config |
| 12 | docker-compose.prod.yml does NOT mount `emqx.conf.production` or `acl.conf.production` | HIGH | A | `docker-compose.prod.yml` |
| 13 | TCP listener 1883 enabled in dev variant of `emqx.conf`; UAT compose env disables it via override — works, but the dev config file itself is wrong | LOW | A | `emqx.conf` |
| 14 | EMQX `node.cookie` hardcoded in dev variant; UAT compose does not thread the variable — inherits from base | MEDIUM | A | `emqx.conf` + compose |
| 15 | Existing 30 stations seeded with `ecdsa_public_key = NULL` and no certs | MEDIUM (data, not config) | E | seeded data |
| 16 | No admin endpoint for provisioning-tokens issuance | HIGH | E | new endpoint required |
| 17 | docker-compose.prod.yml lacks observability stack | HIGH | F | investigate |

### 1.3 Architectural decision: pure mTLS, sidecar MQTT subscriber

The current csms-server uses `EmqxApiPublisher` (POST `/api/v5/publish` to EMQX REST API) for outbound and HTTP webhook for inbound. This is **sandbox pattern**, not OSPP-compliant. Spec at `implementors-guide.md:48`: *"Server (CSMS) — communicates with stations over MQTT."* And `:626`: *"Subscribe to all station messages using shared subscriptions."*

**Decision**: implement a Node.js sidecar (`csms-mqtt-bridge`) that:
- Connects to EMQX with mTLS using a server cert (CN `csms-uat-server-1`).
- Subscribes shared `$share/ospp-servers/ospp/v1/stations/+/to-server` for inbound.
- Pushes inbound messages to Redis (`mqtt:incoming` queue).
- Reads outbound from Redis (`mqtt:outgoing` queue) and publishes via MQTT.

PHP application (csms-server) communicates with sidecar via Redis only:
- Horizon worker pops `mqtt:incoming`, parses, processes, updates DB.
- When a response is needed, worker pushes to `mqtt:outgoing`; sidecar publishes.

**Why Node.js sidecar instead of pure-PHP daemon**:
- `mqtt.js` is the most mature MQTT library (8.4K stars, used by AWS IoT, Azure IoT, IBM Watson).
- Async event-loop model native to MQTT. PHP equivalent (`php-mqtt/client`) is sync.
- MQTT 5 features complete (shared subscriptions, properties, reason codes); php-mqtt partial.
- Memory profile stable (~50MB) vs PHP daemon (100-300MB with leak risks).
- Performance ceiling: 50K msg/sec single-core (mqtt.js) vs ~3K (php-mqtt).
- Match with existing stack: ts-station-simulator already Node.js/TS.
- For wash-station volume (~50-500 msg/sec peak), both work; sidecar gives massive headroom for growth.

**Trade-off**: extra container (~80MB image, ~50MB RAM). Cost negligible vs robustness gained.

### 1.4 Server cert convention

Server cert signed by Station CA (same trust chain as station certs). CN format: `csms-<env>-server-<N>` (e.g., `csms-uat-server-1`, `csms-prod-server-1`). EMQX `peer_cert_as_clientid = cn` makes CN the MQTT clientid. ACL pattern matches `csms-*-server-*`.

Server cert provisioned **out-of-band** via artisan command `ospp:generate-server-cert` (run once per environment, cert lasts 5 years like stations). Documented in Phase 0.6.

### 1.5 Verified file counts at start of implementation

- `routes/internal.php`: 1 route (mqtt/webhook).
- `routes/api/v1/admin.php`: 16 routes including stations CRUD and lifecycle.
- `app/Http/Controllers/Internal/MqttWebhookController.php`: exists.
- `app/Http/Controllers/Api/V1/ProvisioningController.php`: exists, fixed.
- `app/Http/Controllers/Api/V1/Admin/StationManagementController.php`: exists.
- `app/Http/Requests/Admin/RegisterStationRequest.php`: exists.
- `HealthCheckController` + `MetricsController`: exist, wired.
- **No `MqttAuthController` or `MqttAclController` (and we should not add them).**
- **No `csms-mqtt-bridge` Node.js service exists yet — Phase 0 creates it.**

---

## 2. Phased plan

Estimated total: **20–25 hours** of focused implementation work.

### Phase 0 — MQTT subscriber sidecar (Node.js) — estimated 12-15 hours

**Goal**: csms-server speaks proper OSPP MQTT (subscribe + publish via persistent mTLS connection), implemented as a Node.js sidecar service.

**Stack**:
- Node.js 22 LTS
- TypeScript (strict mode)
- `mqtt.js` v5+ for MQTT client
- `ioredis` for Redis pub/sub + BLPOP queues
- `pino` for structured logging
- `prom-client` for Prometheus metrics
- `vitest` for tests
- Docker container, deployed alongside csms-app-uat

**Repo strategy**: separate repo `onestoppay/csms-mqtt-bridge` (independent CI/CD, semver). Decision rationale: clear ownership boundary, independent deployment cadence, container image cleanly versioned.

**Work items**:

0.1. **Initial POC (1h)** — first hour de-risks technical assumptions:
- Connect to UAT EMQX from a local Node script with mTLS using `stn_00000001` cert (already provisioned).
- Subscribe to `ospp/v1/stations/stn_00000001/to-station` (test topic).
- Publish a test message via mqtt.js to that topic.
- Verify message round-trip works.

If POC fails, root-cause before continuing. Common pitfalls: mTLS cert chain misconfiguration, EMQX TLS 1.3-only cipher mismatch, ALPN.

0.2. **Repo bootstrap (1h)** — create `onestoppay/csms-mqtt-bridge`:
- `package.json`, `tsconfig.json` (strict), `eslint.config.js`, `prettier.config.js`
- `Dockerfile` multi-stage (node:22-alpine)
- `docker-compose.yml` snippet for inclusion in csms-server uat/prod compose
- README with architecture diagram and env vars list
- GitHub Actions CI: lint + typecheck + test on push

0.3. **Configuration loader (1h)** — `src/config.ts`:
- Loads from env vars (12-factor): `MQTT_BROKER_URL`, `MQTT_CLIENT_ID`, `MQTT_CERT_PATH`, `MQTT_KEY_PATH`, `MQTT_CA_PATH`, `REDIS_URL`, `LOG_LEVEL`, `METRICS_PORT`.
- Validates all required fields at startup; fails fast.
- Exposes typed config object.

0.4. **MQTT client wrapper (3h)** — `src/mqtt.ts`:
- Connect with mTLS (cert/key/CA from filesystem paths in config).
- Subscribe to `$share/ospp-servers/ospp/v1/stations/+/to-server` with QoS 1, persistent session (`clean: false`, durable clientid).
- On message: extract stationId from topic, push raw message to Redis `mqtt:incoming` (LPUSH).
- Outbound: BLPOP from `mqtt:outgoing` in async loop, publish to MQTT with QoS 1.
- Reconnection logic: built-in mqtt.js with exponential backoff and jitter. Log every state transition.
- LWT on `ospp/v1/server/status` for monitoring.
- Graceful shutdown: SIGTERM → unsubscribe → drain inflight → disconnect → exit. 10s timeout.

0.5. **Redis bridge (2h)** — `src/redis.ts`:
- ioredis client with reconnect.
- `pushIncoming(topic, payload, metadata)`: LPUSH to `mqtt:incoming` with structured envelope `{topic, payload_b64, received_at, qos, properties}`.
- `popOutgoing()`: BLPOP from `mqtt:outgoing`, returns `{topic, payload, qos, properties}` or null on timeout (5s).
- Both queues are simple Redis lists (guaranteed delivery, not fan-out).

0.6. **Server cert provisioning (1h)** — implementation in csms-server:
- New artisan command `ospp:generate-server-cert {environment}` in `app/Console/Commands/GenerateServerCertCommand.php`.
- Generates ECDSA P-256 keypair, builds CSR with CN `csms-<environment>-server-1`.
- Signs CSR with Station CA private key.
- Outputs cert + key + chain to `storage/keys/server-certs/<environment>/`.
- Writes private key with `chmod 0600`.
- Idempotent: skip if valid cert exists; require `--force` to overwrite.

0.7. **Sidecar deployment (1h)**:
- Add `csms-mqtt-bridge` service to `docker-compose.uat.yml` and template in `docker-compose.prod.yml`.
- Mount server cert/key/chain from `storage/keys/server-certs/uat/`.
- Wait-for-EMQX healthcheck dependency.
- Resource limits: 100MB RAM, 0.2 CPU.

0.8. **Horizon worker integration in csms-server (2h)**:
- Modify `ProcessMqttMessage` job (or create) to be invoked from a Redis queue listener.
- New artisan command `mqtt:listen` that BLPOPs `mqtt:incoming` and dispatches `ProcessMqttMessage`.
- **Ordering**: per-stationId queues (`onQueue('mqtt:stn_<id>')`) so messages from one station are serialized.
- Outbound: when worker decides to respond, dispatch `PublishMqttMessage` job which RPUSH to `mqtt:outgoing`.

0.9. **Tests (3h)**:
- Sidecar unit tests: config loader, MQTT message → Redis push (mocked mqtt.js), Redis pop → MQTT publish (mocked Redis).
- Sidecar integration tests: real EMQX in docker-compose.test.yml + real PKI fixtures + assert round-trip end-to-end.
- csms-server tests: `ProcessMqttMessage` processes a sample BootNotification; `PublishMqttMessage` enqueues correctly; `ospp:generate-server-cert` unit-tested.

0.10. **Decommission webhook path** (after sidecar stable):
- Mark `routes/internal.php` MqttWebhook route as `@deprecated`.
- Remove EMQX rule `csms_mqtt_forward` from `init-webhook.sh`.
- Eventually delete `MqttWebhookController` and `VerifyEmqxWebhook` middleware after one prod cycle.

0.11. **Documentation**:
- README.md in csms-mqtt-bridge with architecture, env vars, troubleshooting.
- ADR-001 in csms-server: "MQTT transport via Node.js sidecar".

**Acceptance criteria for Phase 0**:
- POC succeeds: round-trip MQTT message via mqtt.js + mTLS contra UAT EMQX.
- `csms-mqtt-bridge` container starts, connects to EMQX, subscribes successfully.
- Test station publishes BootNotification → message in Redis `mqtt:incoming` within 100ms.
- Horizon worker processes the message, updates DB, station shows `is_online = true`.
- Worker publishes a response → bridge picks up from `mqtt:outgoing` → publishes on MQTT → station receives within 100ms.
- All sub-tests pass.
- `docker stats` shows bridge stable at ~50MB RAM after 1h running.

**Risk mitigation**: Phase 0.1 POC is the gate. If POC reveals incompatibilities, pivot before investing 14h. Fallback options: Mosquitto-PHP extension, single-instance no-shared-sub mode.

---

### Phase A — EMQX UAT switch to pure mTLS (estimated 2-3 hours)

**Goal**: EMQX UAT uses Root CA-validated mTLS, peer_cert_as_clientid, file ACL with `${clientid}` substitution, no env overrides hiding config.

**Pre-requisites**:
- PKI generated (✅ done).
- One station provisioned (`stn_00000001`).
- Server cert provisioned per Phase 0.6 (CN `csms-uat-server-1`).
- Phase 0 sidecar tested and stable.

**Work items**:

A.1. Add `peer_cert_as_clientid = cn` to BOTH `docker/emqx/emqx.conf` and `docker/emqx/emqx.conf.production`. Place inside `listeners.ssl.default.ssl_options { ... }`.

A.2. Configure `cacertfile` correctly:
- `certfile = /opt/emqx/etc/certs/server.pem` (server's cert chain, Let's Encrypt — unchanged)
- `cacertfile = /opt/emqx/etc/certs/station-trust-ca.pem` (Root CA only, validates client certs)

Copy `root-ca-cert.pem` from `csms-app-uat:/var/www/html/storage/keys/` to host path `/opt/osp/csms-server/uat/certs/station-trust-ca.pem`.

A.3. Generate strong `EMQX_WEBHOOK_SECRET` (32 bytes hex). Add to `/opt/osp/csms-server/uat/.env`. Single var name — used by both `init-webhook.sh` and Laravel `config('mqtt.webhook.secret')`.

   *Note: webhook is being deprecated in Phase 0.10. This step is transitional.*

A.4. **Remove env overrides hiding mTLS in BASE compose** (CLI's BLOCKER 3):
- `docker-compose.yml` (BASE): DELETE lines 109 and 110 (verify_none + fail_if_no_peer_cert=false).
- Move these to `docker-compose.dev.yml` (local dev override).
- UAT and prod compose inherit secure default.

A.5. Switch UAT to mount production EMQX configs. Edit `docker-compose.uat.yml`:
```yaml
services:
  emqx:
    volumes:
      - ./docker/emqx/emqx.conf.production:/opt/emqx/etc/emqx.conf:ro
      - ./docker/emqx/acl.conf.production:/opt/emqx/etc/acl.conf:ro
```

A.6. Update `acl.conf.production`:
- Keep `stn_*` rules (station topic isolation).
- Update server rules to `csms-server-*` pattern (matches both UAT and prod). Allow subscribe on shared `$share/ospp-servers/ospp/v1/stations/+/to-server`, publish on `ospp/v1/stations/+/to-station` and `ospp/v1/server/status`.
- Remove SIM-* / sim-* rules.
- Keep `{deny, all}` at end.

A.7. Use `${EMQX_NODE_COOKIE:?required}` notation in compose. Generate strong cookie (32+ chars) in `.env`.

A.8. Restart EMQX on UAT and verify:
```bash
docker exec csms-emqx-uat /opt/emqx/bin/emqx ctl conf show listeners.ssl.default.ssl_options
```
Output must show: `verify = verify_peer`, `fail_if_no_peer_cert = true`, `peer_cert_as_clientid = cn`, `cacertfile = /opt/emqx/etc/certs/station-trust-ca.pem`.

A.9. Webhook secret round-trip test (transitional).

A.10. End-to-end test with real station cert:
- `simulator connect --target uat --station stn_00000001`
- TLS handshake succeeds, station cert validated by Root CA, CN `stn_00000001` becomes clientid.
- ACL allows publish on `ospp/v1/stations/stn_00000001/to-server`.
- Sidecar receives via shared subscription, pushes to Redis.
- Horizon worker processes, marks `is_online = true`.
- Response flows back through `mqtt:outgoing` → sidecar → MQTT → station.

A.11. **Atomic commit**: A.4 + A.5 + A.6 committed together (CLI's R1).

A.12. **Config validation test** (CLI's R5):
- Run `docker compose -f docker-compose.yml -f docker-compose.uat.yml config` with production EMQX configs mounted.
- Parse YAML output, assert no `verify_none`, no `fail_if_no_peer_cert=false`, volumes include `.production` configs.

**Acceptance criteria**:
- `emqx ctl conf show authorization` → `no_match = deny`.
- Self-signed cert fails TLS handshake.
- Provisioned station + sidecar connect; messages flow; DB updates.
- `simulator connect` succeeds; `is_online = true`.

---

### Phase B — Secrets management correctness (estimated 1-2 hours)

**Goal**: secrets not in Docker image layers; injected at runtime via bind-mount.

**Work items**:

B.1. Update `.dockerignore` to exclude `.env`.

B.2. Update `docker-compose.uat.yml` and `docker-compose.yml` (base) so the `app` service uses bind-mount of `.env` at `/var/www/html/.env`. Laravel reads via vlucas/phpdotenv.

B.3. Rebuild app image. Verify `.env` not in image:
```bash
docker history uat-app:latest --no-trunc | grep -i env
docker create --name verify-image uat-app:latest
docker export verify-image | tar -tvf - | grep '\.env$'
docker rm verify-image
```

B.4. Restart container. Verify Laravel reads MASTER_KEY:
```bash
docker exec csms-app-uat php artisan tinker --execute "echo config('ospp.crypto.master_key');"
```

B.5. Verify encrypt/decrypt operations on Root CA / Station CA still work.

B.6. Document MASTER_KEY rotation in `docs/SECURITY-KEY-ROTATION.md`. Procedure:
1. Generate new MASTER_KEY.
2. Tinker: load each encrypted key with old MASTER_KEY, decrypt to PEM in temp.
3. Update `.env`.
4. Tinker: re-encrypt with new MASTER_KEY.
5. Restart app + sidecar.
6. Cleanup temp PEMs.

May require new `KeyStore::reEncrypt()` method with tests.

**Acceptance criteria**:
- `docker history` shows no `.env` content.
- `.env` not in image filesystem (tar inspect confirms).
- App reads MASTER_KEY at runtime.
- Encrypt/decrypt still works.

---

### Phase E — Provisioning lifecycle endpoints (estimated 2 hours)

**Goal**: admin registers station and issues provisioning token entirely through API. No SQL.

**Work items**:

E.1. Test `POST /api/v1/admin/stations`:
- Auth: `POST /api/v1/auth/login`.
- Body per `RegisterStationRequest`: stationId, stationModel, stationVendor, locationId, bays[].
- Verify response and DB row created with `ecdsa_public_key = NULL`.

E.2. Read `StationManagementController::registerStation`. Document API contract in `docs/PROVISIONING.md`.

E.3. **Confirm** no admin endpoint exists for provisioning-token issuance. CLI verified PASUL A: not present.

E.4. **Implement** `POST /api/v1/admin/stations/{stationId}/provisioning-tokens`:
- Auth: `auth.jwt` + `rbac:platform_admin`.
- Body: `{ "expiresInHours": <int, default 24, max 168> }`.
- Generate 32-byte cryptographically secure random token.
- Hash with SHA-256.
- Insert into `provisioning_tokens` (id, token=hash, station_id, expires_at, created_by).
- Response 201: `{ "token": "<plain hex>", "expiresAt": "ISO8601", "stationId": "..." }`.
- **Plain token returned ONLY on creation**.
- Audit log entry.
- Throttle: `5,1` per minute.
- Files: `ProvisioningTokenController.php`, `IssueProvisioningTokenRequest.php`.

E.5. End-to-end test:
- Admin registers station.
- Admin issues token.
- Simulator provisions: `simulator provision <stationId> --target uat --token <plain>`.
- Simulator connects.
- Station shows `is_online = true`.

E.6. Document in `docs/PROVISIONING.md` with curl examples and troubleshooting.

**Acceptance criteria**:
- New station onboarded end-to-end via API + simulator with no manual SQL.
- Feature test passes for full flow.

---

### Phase C — Observability (estimated 2 hours)

**Goal**: Prometheus scrapes app + sidecar metrics. Loki ingests logs. Health endpoints reachable.

**Work items**:

C.1. **Verify health endpoints** (already implemented per CLI). Test from inside csms-network:
- `curl http://app:9000/health`
- `curl http://app:9000/health/ready`
- `curl http://app:9000/health/live`
- If returns nothing or non-200, debug routing/bootstrap.

C.2. **Verify metrics endpoint** (already implemented per CLI):
- `curl http://app:9000/metrics` returns Prometheus format.
- Prometheus targets show `csms-app` health = `up`.
- Currently failing; root-cause and fix.

C.3. **Clean orphan** `routes/metrics.php` (closure not loaded by bootstrap; real metrics in `routes/health.php:23`).

C.4. Add custom OSPP metrics to `PrometheusMetrics`:
- `ospp_messages_received_total{station_id}` counter
- `ospp_messages_processed_total{action}` counter
- `ospp_provisioning_total{result}` counter
- `ospp_certificate_issued_total` counter
- `ospp_certificate_revoked_total` counter
- `ospp_stations_online` gauge
- `ospp_mqtt_bridge_inflight` gauge (from sidecar)

C.5. Loki log shipping. Configure Docker daemon Loki driver:
```yaml
services:
  app:
    logging:
      driver: loki
      options:
        loki-url: "http://loki:3100/loki/api/v1/push"
        loki-batch-size: "400"
```

C.6. Grafana dashboard `docker/grafana/provisioning/dashboards/csms-server.json`:
- Stations online gauge
- Messages/min rate
- Provisioning events
- Errors rate
- Cert renewals
- Certs near expiry

C.7. Alertmanager rules:
- Stations online drop > 50% in 5 min.
- Cert expires in < 7 days.
- Webhook/sidecar receives 0 messages > 10 min.
- Sidecar `mqtt_bridge_connected` gauge = 0.

**Acceptance criteria**:
- All health/metrics endpoints return 200 with expected payloads.
- Prometheus targets `up`.
- Loki query returns recent logs.
- Grafana dashboard shows live data.
- ≥ 2 alert rules.

---

### Phase D — Backups (estimated 1 hour)

**Goal**: nightly Postgres dump, 30-day retention, restore tested.

**Work items**:

D.1. Create `/opt/osp/csms-server/uat/backups/` (chmod 0700, gabi:gabi).

D.2. Verify `scripts/backup-database.sh` and `scripts/restore-database.sh` work end-to-end.

D.3. Add cron:
```cron
0 3 * * * /opt/osp/csms-server/uat/scripts/backup-database.sh >> /var/log/csms-uat-backup.log 2>&1
```

D.4. Test restore on throwaway data.

D.5. Document in `docs/BACKUP-RESTORE.md` (consolidate with existing `docs/backup-restore.md`).

D.6. 30-day retention in backup script:
```bash
find /opt/osp/csms-server/uat/backups -name "*.sql.gz" -mtime +30 -delete
```

**Acceptance criteria**:
- Backups directory contains scheduled dumps.
- Cron registered.
- Restore demonstrated.
- Old backups auto-cleaned.

---

### Phase F — Hardening backlog (deferred)

- F.1. Cert renewal automation (artisan scheduled).
- F.2. Cert revocation API and CRL distribution.
- F.3. MASTER_KEY in real secrets vault.
- F.4. Init container that copies Root CA to EMQX certs volume.
- F.5. `docker-compose.prod.yml` parity audit.
- F.6. Webhook deprecation full cleanup.
- F.7. Multi-instance sidecar deployment for HA.

---

## 3. Implementation guidance for Claude CLI

### 3.1 Operating mode

Each phase = one CLI session. Maximum thinking budget. Read this audit, OSPP spec relevant to phase, existing code, **then verify**.

### 3.2 Verification protocol — before implementing each phase

1. Re-read relevant audit sections.
2. Verify current state matches audit. Run diagnostic commands.
3. Read all related source files.
4. Identify inaccurate audit claims. Correct them in your reply before proceeding.
5. List prerequisites the audit didn't enumerate. Resolve or flag.
6. Then write code.

### 3.3 Test discipline

- Every phase produces or modifies tests.
- **Phase 0**: real EMQX in test-compose; mocked dependencies for unit tests; POC validates assumptions before committing 14h.
- **Phase A**: feature tests with real PKI (no mocks at boundary). Model: `RealCsrProvisioningTest` from commit `0b145eb`.
- **Phase B**: tests assert MASTER_KEY readable from runtime; CI fails if `.env` in image.
- **Phase E**: feature test for full register→token→provision→connect flow. No SQL inserts in test setup.
- **Phase C**: tests for health/metrics endpoints; metrics format snapshot.
- **Phase D**: smoke test backup → restore on throwaway DB.

### 3.4 Commit hygiene

- One feature per commit. Don't bundle unless inseparable (A.4+A.5+A.6 are explicitly bundled).
- Imperative present tense. What + why + scope.
- Reference audit section: `Per AUDIT v2 §A.5, mount production EMQX configs`.
- Push after each phase.

### 3.5 NEVER

- Weaken security to make a test pass.
- Introduce env overrides hiding config defects.
- Paper over a 500 with a 400.
- Bypass RBAC on admin endpoints.
- Write or distribute MASTER_KEY in plain text outside protected `.env`.
- Skip Phase 0.1 POC.
- Mix MQTT subscriber and HTTP webhook patterns. Sidecar is the chosen path.

### 3.6 ALWAYS

- Validate every change with real exercise on UAT before committing.
- Read existing tests before modifying that area.
- Check OSPP spec for protocol-level decisions.
- Ask user when in doubt.
- After each phase: update PROJECT-STATUS.md.

---

## 4. Summary of UAT after these phases

- Stations onboard via API (admin JWT + RBAC), receive single-use provisioning token, run CSR-based provisioning, connect over mTLS exactly as real hardware will.
- EMQX validates every connection against Root CA. CN must match clientid. ACL deny-by-default.
- **csms-server is a real MQTT client** via Node.js sidecar `csms-mqtt-bridge`. Subscribes shared, publishes via persistent mTLS. Aligned with OSPP spec.
- Webhook + EMQX REST API path is deprecated and (eventually) removed.
- Secrets do not live in Docker images.
- Logs ship to Loki, metrics to Prometheus, alerts via Alertmanager. Grafana dashboard.
- Nightly backups, restorable.
- Tested end-to-end via simulator.

When that is true, deploying prod is mostly:
- Fresh DB, fresh PKI (independent Root CA — never share with UAT).
- Fresh secrets in `.env` from prod vault.
- `docker-compose.prod.yml` mounting same production EMQX config.
- Server cert provisioned with CN `csms-prod-server-1`.
- Sidecar deployed.
- Smoke test with one real station.

That is what UAT-as-prod-mirror buys.

---

*End of audit v2. Implementer: read this fully, verify, then start with Phase 0.1 POC.*
