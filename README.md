# csms-mqtt-bridge

Node.js sidecar that bridges the EMQX MQTT broker (mTLS, MQTT 5, persistent
session) and Redis queues for the CSMS server. The CSMS application
(Laravel/PHP) communicates with stations exclusively through this sidecar.

Aligned with the OSPP spec — see `implementors-guide.md:48,227,626,1150`.

## Status

Active development. Built incrementally per the parent audit's Phase 0
roadmap.

| Phase | Scope                                                                                                                                                          | Status  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0.1   | POC — `mqtt@5` + Node 22 + mTLS round-trip against UAT EMQX (~469 ms, zero compatibility issues)                                                               | done    |
| 0.2   | Repo bootstrap (TypeScript strict, ESLint flat, Dockerfile, CI)                                                                                                | done    |
| 0.3   | Typed env-var loader (`zod` v4) with file-existence + protocol checks; insecure-TLS warning                                                                    | done    |
| 0.4   | MQTT client wrapper: persistent mTLS, MQTT 5, plain persistent subscription, LWT, reconnect logging                                                            | done    |
| 0.5   | At-least-once delivery — manual-ack inbound (outbound half removed, ADR-0001)                                                                                  | done    |
| 0.6   | Server cert provisioning (artisan command in `csms-server`)                                                                                                    | next    |
| 0.7a  | GHCR auto-publish (multi-arch Docker image on `v*.*.*` tag push)                                                                                               | done    |
| 0.7b+ | csms-server compose integration, `mqtt:consume` worker, tests, decommissioning the legacy webhook path — inbound done; outbound never wired (see Architecture) | partial |

## Architecture

```
   INBOUND  (this service)
   ┌──────────────┐   mTLS MQTT    ┌──────────────┐   mTLS MQTT    ┌──────────────────┐  Redis LIST   ┌────────────────┐
   │   Stations   │ ──────────────▶│ EMQX broker  │ ──────────────▶│ csms-mqtt-bridge │ ─────────────▶│  csms-server   │
   │ CN: stn_*    │  to-server     │  (clustered) │  plain sub     │  (this service)  │ mqtt:incoming │   (Laravel)    │
   └──────────────┘  QoS 1         └──────────────┘  CN: csms-*-srv└──────────────────┘  LPUSH        └────────────────┘
          ▲                               ▲                                                                   │
          │                               │            EMQX REST API — POST /api/v5/publish                    │
          └───────────────────────────────┴───────────────────────────────────────────────────────────────────┘
                                    OUTBOUND  (does NOT pass through this service)
```

- **Inbound**: bridge subscribes to `ospp/v1/stations/+/to-server` — a PLAIN
  (non-shared) subscription on a persistent session — and `LPUSH`es each message
  onto the Redis list `mqtt:incoming`. csms-server's `php artisan mqtt:consume`
  worker consumes it with `BLMOVE … RIGHT LEFT` (FIFO) and dispatches.
  `$share/` was dropped in `2ba00e8`: EMQX does not queue a shared subscription's
  messages for an offline member, so a bridge restart dropped them (AUDIT-05 F-02).
- **Outbound**: not this service. Server→station traffic goes over the EMQX REST
  API (`EmqxApiPublisher` → `POST /api/v5/publish`). The bridge had a Redis-queue
  outbound half; it never had a producer and was removed — see
  [ADR-0001](./docs/ADR-0001-outbound-path-removed.md).
- **Identity**: bridge authenticates with a server certificate signed by the
  Station CA; the CN convention is `csms-<env>-server-<N>` (e.g. `csms-uat-server-1`).
  EMQX maps the CN to the MQTT clientid via `peer_cert_as_clientid = cn`.

The bridge holds no business logic. It is intentionally thin — only protocol
translation and resilience (reconnect, backoff, in-flight bookkeeping).

## Stack

- Node.js 22 LTS
- TypeScript (strict mode, `NodeNext`)
- [`mqtt`](https://github.com/mqttjs/MQTT.js) v5+ — MQTT client
- [`ioredis`](https://github.com/redis/ioredis) — Redis client
- [`pino`](https://github.com/pinojs/pino) — structured logging
- [`prom-client`](https://github.com/siimon/prom-client) — Prometheus metrics
- [`zod`](https://zod.dev/) v4 — env-var validation
- [`vitest`](https://vitest.dev/) — tests
- ESLint flat config + Prettier

## Environment variables

Defined and validated by [`src/config.ts`](./src/config.ts). All required
values are checked at startup; any failure exits the process with a single
structured error listing every issue. See [`.env.example`](./.env.example)
for a copy-paste starting point.

### Required

| Name              | Description                                                              | Example                               |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `MQTT_BROKER_URL` | Broker URL incl. protocol.                                               | `mqtts://mqtt-uat.onestoppay.ro:8884` |
| `MQTT_CLIENT_ID`  | Sidecar clientid; must match CN of the server certificate.               | `csms-uat-server-1`                   |
| `MQTT_CERT_PATH`  | PEM path to the server certificate (signed by Station CA).               | `/run/secrets/server-cert.pem`        |
| `MQTT_KEY_PATH`   | PEM path to the server private key (mode 0600). Never logged.            | `/run/secrets/server-key.pem`         |
| `REDIS_URL`       | Redis URL incl. protocol; credentials in the URL are redacted from logs. | `redis://csms-redis:6379/0`           |

### Optional (defaults shown)

| Name                           | Default         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MQTT_CA_PATH`                 | _unset_         | PEM path to the CA bundle for verifying the broker certificate. When unset, mqtt.js / `tls.connect` fall back to Node's default trust (system CA bundle, includes Let's Encrypt and other public roots) — the right choice when the broker presents a publicly-trusted cert. Required only for non-public CAs (self-signed, internal Station CA).                                                                                                                                                                              |
| `MQTT_SERVERNAME`              | _unset_         | TLS SNI hostname override sent during the handshake. Set when the broker cert SAN doesn't include the connect hostname (e.g. connecting via an internal Docker alias `emqx` to a broker whose cert covers `*.onestoppay.ro`). When unset, mqtt.js sends the host portion of `MQTT_BROKER_URL`.                                                                                                                                                                                                                                 |
| `MQTT_REJECT_UNAUTHORIZED`     | `true`          | Validate the broker certificate. When `MQTT_CA_PATH` is set, validation runs against that bundle; otherwise against Node's system CA trust. **Do not set to `false` outside an ephemeral sandbox.** Accepted: `true`/`1`/`yes`, `false`/`0`/`no` (case-insensitive).                                                                                                                                                                                                                                                           |
| `LOG_LEVEL`                    | `info`          | Pino level: `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `METRICS_PORT`                 | `9090`          | Prometheus exporter port (1–65535).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SHUTDOWN_TIMEOUT_MS`          | `10000`         | Graceful shutdown deadline in ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MQTT_KEEPALIVE`               | `60`            | MQTT keepalive interval, in seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `MQTT_RECONNECT_PERIOD`        | `5000`          | MQTT reconnect base period in ms (mqtt.js layers exponential backoff + jitter on top).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MQTT_CONNECT_TIMEOUT`         | `30000`         | Initial connect deadline in ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `MQTT_SESSION_EXPIRY_INTERVAL` | `3600`          | MQTT 5 Session Expiry Interval in seconds; with `clean:false` keeps the subscription + its queued QoS-1 messages alive across a brief disconnect (must be > 0).                                                                                                                                                                                                                                                                                                                                                                |
| `REDIS_QUEUE_INCOMING`         | `mqtt:incoming` | Redis list key for inbound messages from broker → server.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `REDIS_REQUIRE_NOEVICTION`     | `true`          | Refuse to start when the queue Redis reports a `maxmemory-policy` other than `noeviction`. Under an eviction policy an `LPUSH` reports success, the bridge PUBACKs, the broker drops its copy, and Redis discards the entry — the message is lost on both sides with no error (measured: 400 pushes → 400 acked, 16 surviving). Fails closed: an undeterminable policy is treated as unsafe. `false` downgrades the refusal to a warning plus `csms_bridge_queue_durability_violations_total`; it does not make the loss safe. |
| `WATCHDOG_MQTT_DOWN_MS`        | `120000`        | How long the broker connection may stay down (a broker never reached since start counts) before the bridge exits non-zero for its restart policy to restart it. At least `1000`. See [A stuck bridge exits](#a-stuck-bridge-exits).                                                                                                                                                                                                                                                                                            |
| `WATCHDOG_INBOUND_STALL_MS`    | `60000`         | How long one inbound message may stay in hand (its Redis push unsettled), or stay unacknowledged waiting for a new connection, before the bridge exits non-zero. At least `1000`.                                                                                                                                                                                                                                                                                                                                              |

## Build & run

Local development should use **Node 22 LTS** to match CI and the production
container. The repo ships a `.nvmrc` file so:

```bash
nvm use   # picks up .nvmrc → Node 22
```

Mixing Node 24 locally and Node 22 in CI is supported (current code is
forward-compatible) but small drift bugs can sneak in — keep the dev
environment aligned.

### Local development

```bash
npm install
npm run dev            # tsx watch — reloads on save
```

### Production-style build

```bash
npm run typecheck
npm run lint
npm run test
npm run build          # → dist/index.js
node dist/index.js
```

### Docker

```bash
docker build -t csms-mqtt-bridge:dev .
docker run --rm \
  -e MQTT_BROKER_URL=mqtts://mqtt-uat.onestoppay.ro:8884 \
  -e MQTT_CLIENT_ID=csms-uat-server-1 \
  -e MQTT_CERT_PATH=/certs/server.crt \
  -e MQTT_KEY_PATH=/certs/server.key \
  -e MQTT_CA_PATH=/certs/root-ca.pem \
  -e REDIS_URL=redis://redis:6379/0 \
  -v /opt/osp/certs:/certs:ro \
  csms-mqtt-bridge:dev
```

The Dockerfile is multi-stage (deps / builder / runtime) on `node:22-alpine`.
Final image is ~178 MB (the Node 22 runtime alone is ~150 MB; getting below
that would require a different runtime). `tini` handles PID 1 signals so
SIGTERM triggers a graceful shutdown.

## Deploying

Tagged releases publish a multi-arch image (`linux/amd64` + `linux/arm64`)
to GitHub Container Registry. The publish runs from
[`.github/workflows/release.yml`](./.github/workflows/release.yml) on every
`v*.*.*` tag push.

```bash
# Latest stable
docker pull ghcr.io/ospp-org/csms-mqtt-bridge:latest

# Pin to a specific release
docker pull ghcr.io/ospp-org/csms-mqtt-bridge:0.1.0

# Pin to a specific commit (e.g. for a hotfix verification)
docker pull ghcr.io/ospp-org/csms-mqtt-bridge:sha-3fb03ad
```

### Available tags

| Pattern       | Example       | Stability                                                          |
| ------------- | ------------- | ------------------------------------------------------------------ |
| `latest`      | `latest`      | Highest published semver. Convenient; **don't pin in production**. |
| `vX.Y.Z`      | `v0.1.0`      | Exact git tag. Immutable.                                          |
| `X.Y.Z`       | `0.1.0`       | Same image as `vX.Y.Z`, no `v` prefix.                             |
| `X.Y`         | `0.1`         | Latest patch in the X.Y line. Rolls forward on new patches.        |
| `sha-<short>` | `sha-3fb03ad` | Tag's commit SHA (7 chars). Immutable.                             |

The image carries SLSA build provenance and an SBOM attached at push time.
Inspect manifest, platforms, and labels with:

```bash
docker buildx imagetools inspect ghcr.io/ospp-org/csms-mqtt-bridge:0.1.0
```

Run as you would the locally-built image — see the `docker run` example
above and the [environment variables](#environment-variables) table for
required configuration.

### TLS SNI when connecting via an internal hostname

> ⚠️ **Known limitation (mqtt.js v5.15.1)**: `MQTT_SERVERNAME` is currently
> ignored by `mqtt.js` due to an upstream bug at `connect/tls.js:28`
> (`opts.servername = opts.host` runs unconditionally for hostname targets,
> overwriting the user-provided `servername`). The variable is plumbed
> through correctly by this bridge — it will start working the day the
> upstream fix lands, with no code change required here.
>
> **Workaround until upstream is fixed**: use a Docker network alias so the
> connect URL host already matches the broker certificate SAN. Then SNI =
> connect host = SAN entry, and the handshake validates without needing
> `MQTT_SERVERNAME` at all.
>
> ```yaml
> # docker-compose.yml — broker side advertises the public hostname as alias
> services:
>   emqx:
>     networks:
>       csms-network:
>         aliases:
>           - mqtt-uat.onestoppay.ro # match broker cert SAN
>
>   mqtt-bridge:
>     environment:
>       MQTT_BROKER_URL: mqtts://mqtt-uat.onestoppay.ro:8883 # alias resolves intra-Docker
> ```
>
> The alias is intra-Docker only — no public DNS hop, no traffic leaves the
> compose network. mqtt.js still defaults SNI to the URL host, but now that
> host is the SAN-covered hostname, so validation succeeds.

When the bridge connects to the broker over an internal hostname that the
broker certificate doesn't cover — typically a Docker network alias like
`emqx` paired with a public-domain cert (`mqtt-uat.onestoppay.ro`) — the
TLS handshake will fail certificate validation because mqtt.js defaults
the SNI servername to the connect host.

Set `MQTT_SERVERNAME` to the hostname covered by the cert SAN to override
just the SNI servername without changing where the bridge connects:

```bash
MQTT_BROKER_URL=mqtts://emqx:8883
MQTT_SERVERNAME=mqtt-uat.onestoppay.ro
# MQTT_CA_PATH unset — system trust is used (Let's Encrypt, etc.)
```

The TCP/TLS connection still goes to `emqx:8883`, but the TLS ClientHello
sends `mqtt-uat.onestoppay.ro` as the SNI hostname, which the broker uses
to select the correct certificate and which the client uses to validate
against the cert's SAN list.

When the broker presents a publicly-trusted certificate (Let's Encrypt,
DigiCert, etc.), `MQTT_CA_PATH` can be omitted entirely — Node's default
trust store includes the major public roots. Set `MQTT_CA_PATH` only when
the broker uses a non-public CA (self-signed, internal Station CA).

## Observability

The bridge serves two endpoints on `METRICS_PORT` (default `9090`), intra-network only —
no host port is published.

### `GET /healthz`

Answers the two questions that decide whether the process is doing its job: is it
attached to the broker, and can it write the Redis queue.

- **`200`** with `{"status":"ok",...}` when both hold.
- **`503`** otherwise, with a body naming which leg failed:

  ```json
  {
    "status": "unhealthy",
    "checks": { "mqttConnected": false, "redisReady": true },
    "lastMessageAgeSeconds": null,
    "reconnectCount": 0
  }
  ```

`lastMessageAgeSeconds` is reported but is deliberately **not** part of the verdict —
a quiet fleet is not a broken bridge, and a probe that failed on silence would flap on
a deployment averaging ~100 messages a day.

The image carries a `HEALTHCHECK` that calls this route. A compose-level
`healthcheck:` overrides it; `csms-server`'s compose files set
`test: ["CMD-SHELL", "kill -0 1"]` up to bridge 0.1.7 and leave the image's check in
place from 0.2.0.

A health check marks a container unhealthy; it does not restart it. What restarts a
stuck bridge is the bridge itself exiting - see below.

### A stuck bridge exits

The container's restart policy restarts a bridge that exits and does nothing for one
that stays alive and stuck. The bridge watches for the three ways it can, and on any of
them logs `bridge is stuck` at `fatal` with the condition, then exits **1** through the
ordinary shutdown (bounded by `SHUTDOWN_TIMEOUT_MS`):

| Condition         | What it is                                                                                                                                                                                                                                                           | Limit                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `mqtt_down`       | The broker connection lost and not back - mqtt.js retries for as long as the broker refuses it (an expired or rotated certificate, an ACL that no longer admits the client id), and never with `MQTT_RECONNECT_PERIOD=0`. A broker never reached since start counts. | `WATCHDOG_MQTT_DOWN_MS`     |
| `inbound_stalled` | One inbound message in hand past the limit: its Redis push neither resolved nor rejected (`maxRetriesPerRequest: null` queues a command while Redis is gone). mqtt.js handles inbound packets one at a time, so every station waits behind it.                       | `WATCHDOG_INBOUND_STALL_MS` |
| `unacked_pending` | A push was refused, so the PUBACK was withheld and the broker kept the message - and resends it only on a new connection (`retry_interval = infinity` on the deployed EMQX). After `max_inflight` (32) such messages the broker delivers nothing more.               | `WATCHDOG_INBOUND_STALL_MS` |

A restart loses nothing in any of them: the session is persistent, nothing in hand or
refused was acknowledged, and the broker resends every unacknowledged message on the
next connection.

### The inbound grant

After each SUBSCRIBE the bridge reads the SUBACK. A refusal (a reason code with the
`0x80` bit - `135` Not authorized is what an ACL deny answers) or a grant below the
QoS 1 it asked for is logged at `fatal` and the bridge exits **1**: at QoS 0 the broker
queues nothing for the persistent session and waits for no PUBACK, so the manual ack
guards nothing. A SUBSCRIBE cut off by a closing connection is not a refusal; the next
connection subscribes again.

### `GET /metrics`

Prometheus exposition, on a registry private to the bridge (not the prom-client
global default), with `service="csms-mqtt-bridge"` as a default label.

| Metric                                                  | Type    | Meaning                                                                                                                   |
| ------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `csms_bridge_build_info{version}`                       | gauge   | Running build. Always 1; the label carries the information.                                                               |
| `csms_bridge_topic_drops_total{reason}`                 | counter | Inbound messages acked and dropped because the topic failed the OSPP `to-server` pattern.                                 |
| `csms_bridge_inbound_push_failures_total`               | counter | Inbound messages the bridge failed to enqueue and therefore did **not** ack. The healthy failure — the broker redelivers. |
| `csms_bridge_queue_durability_violations_total{policy}` | counter | Startup checks that found `maxmemory-policy != noeviction`. Non-zero means messages can be evicted after being acked.     |
| `csms_bridge_mqtt_connected`                            | gauge   | 1 when attached to the broker.                                                                                            |
| `csms_bridge_redis_connected`                           | gauge   | 1 when Redis is ready. **0 means inbound is stalled** — pushes neither resolve nor reject, so nothing is acked.           |
| `csms_bridge_reconnects_total`                          | gauge   | MQTT reconnect attempts since start.                                                                                      |
| `csms_bridge_last_message_age_seconds`                  | gauge   | Seconds since the last inbound message; **-1** when none since start (not 0, which would read as "just arrived").         |

Plus `collectDefaultMetrics` (event-loop lag, GC, heap).

## Repository layout

```
.
├── Dockerfile               # multi-stage build
├── eslint.config.js         # flat config + typescript-eslint strict
├── prettier.config.js
├── tsconfig.json            # strict mode, ES2022 + NodeNext
├── package.json
├── src/
│   └── index.ts             # entrypoint (placeholder until Phase 0.3)
└── .github/workflows/ci.yml # lint + typecheck + test + build
```

## Related

- Parent audit & roadmap (mirror copy): [`docs/AUDIT-UAT-PROD-MIRROR.md`](./docs/AUDIT-UAT-PROD-MIRROR.md)
- OSPP spec: `implementors-guide.md`
- CSMS server (Laravel): `ospp-org/csms-server`

## License

MIT — see [LICENSE](./LICENSE).
