# csms-mqtt-bridge

Node.js sidecar that bridges the EMQX MQTT broker (mTLS, MQTT 5, shared
subscriptions) and Redis queues for the CSMS server. The CSMS application
(Laravel/PHP) communicates with stations exclusively through this sidecar.

Aligned with the OSPP spec — see `implementors-guide.md:48,227,626,1150`.

## Status

Active development. Built incrementally per the parent audit's Phase 0
roadmap.

| Phase | Scope                                                                                                          | Status |
| ----- | -------------------------------------------------------------------------------------------------------------- | ------ |
| 0.1   | POC — `mqtt@5` + Node 22 + mTLS round-trip against UAT EMQX (~469 ms, zero compatibility issues)               | done   |
| 0.2   | Repo bootstrap (TypeScript strict, ESLint flat, Dockerfile, CI)                                                | done   |
| 0.3   | Typed env-var loader (`zod` v4) with file-existence + protocol checks; insecure-TLS warning                    | done   |
| 0.4   | MQTT client wrapper: persistent mTLS, MQTT 5, shared subscription, LWT, reconnect logging, outbound BLPOP loop | done   |
| 0.5   | At-least-once delivery — manual-ack inbound + BLMOVE outbound + startup replay                                 | done   |
| 0.6   | Server cert provisioning (artisan command in `csms-server`)                                                    | next   |
| 0.7a  | GHCR auto-publish (multi-arch Docker image on `v*.*.*` tag push)                                               | done   |
| 0.7b+ | csms-server compose integration, Horizon worker, tests, decommissioning the legacy webhook path                | —      |

## Architecture

```
                                    inbound
                       ────────────────────────────▶
   ┌──────────────┐    mTLS MQTT     ┌──────────────┐    mTLS MQTT     ┌──────────────────┐    Redis LIST    ┌────────────────┐
   │              │                  │              │ $share/ospp-...  │                  │  mqtt:incoming   │                │
   │   Stations   │◀────────────────▶│ EMQX broker  │◀────────────────▶│ csms-mqtt-bridge │◀────────────────▶│  csms-server   │
   │ CN: stn_*    │  port 8883/8884  │  (clustered) │  CN: csms-*-srv  │  (this service)  │  mqtt:outgoing   │   (Laravel)    │
   │              │                  │              │                  │                  │                  │                │
   └──────────────┘                  └──────────────┘                  └──────────────────┘                  └────────────────┘
                       ◀────────────────────────────
                                    outbound
```

- **Inbound**: bridge subscribes to `$share/ospp-servers/ospp/v1/stations/+/to-server`
  (shared subscription per OSPP spec line 626) and `LPUSH`es each message onto the
  Redis list `mqtt:incoming`. A Horizon worker on csms-server pops and processes.
- **Outbound**: bridge `BLPOP`s from `mqtt:outgoing`, then publishes to
  `ospp/v1/stations/{id}/to-station` over its persistent mTLS connection.
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

| Name                       | Default         | Description                                                                                                                                                           |
| -------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MQTT_CA_PATH`             | _unset_         | PEM path to the CA bundle for verifying the broker certificate. When unset, mqtt.js / `tls.connect` fall back to Node's default trust (system CA bundle, includes Let's Encrypt and other public roots) — the right choice when the broker presents a publicly-trusted cert. Required only for non-public CAs (self-signed, internal Station CA). |
| `MQTT_SERVERNAME`          | _unset_         | TLS SNI hostname override sent during the handshake. Set when the broker cert SAN doesn't include the connect hostname (e.g. connecting via an internal Docker alias `emqx` to a broker whose cert covers `*.onestoppay.ro`). When unset, mqtt.js sends the host portion of `MQTT_BROKER_URL`. |
| `MQTT_REJECT_UNAUTHORIZED` | `true`          | Validate the broker certificate. When `MQTT_CA_PATH` is set, validation runs against that bundle; otherwise against Node's system CA trust. **Do not set to `false` outside an ephemeral sandbox.** Accepted: `true`/`1`/`yes`, `false`/`0`/`no` (case-insensitive). |
| `LOG_LEVEL`                | `info`          | Pino level: `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`.                                                                                             |
| `METRICS_PORT`             | `9090`          | Prometheus exporter port (1–65535).                                                                                                                                   |
| `SHUTDOWN_TIMEOUT_MS`      | `10000`         | Graceful shutdown deadline in ms.                                                                                                                                     |
| `MQTT_KEEPALIVE`           | `60`            | MQTT keepalive interval, in seconds.                                                                                                                                  |
| `MQTT_RECONNECT_PERIOD`    | `5000`          | MQTT reconnect base period in ms (mqtt.js layers exponential backoff + jitter on top).                                                                                |
| `MQTT_CONNECT_TIMEOUT`     | `30000`         | Initial connect deadline in ms.                                                                                                                                       |
| `REDIS_QUEUE_INCOMING`     | `mqtt:incoming` | Redis list key for inbound messages from broker → server.                                                                                                             |
| `REDIS_QUEUE_OUTGOING`     | `mqtt:outgoing` | Redis list key for outbound messages from server → broker.                                                                                                            |
| `REDIS_BLPOP_TIMEOUT_SEC`  | `5`             | BLPOP block timeout when polling the outgoing queue, in seconds.                                                                                                      |

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

| Pattern       | Example       | Stability                                                |
| ------------- | ------------- | -------------------------------------------------------- |
| `latest`      | `latest`      | Highest published semver. Convenient; **don't pin in production**. |
| `vX.Y.Z`      | `v0.1.0`      | Exact git tag. Immutable.                                |
| `X.Y.Z`       | `0.1.0`       | Same image as `vX.Y.Z`, no `v` prefix.                   |
| `X.Y`         | `0.1`         | Latest patch in the X.Y line. Rolls forward on new patches. |
| `sha-<short>` | `sha-3fb03ad` | Tag's commit SHA (7 chars). Immutable.                   |

The image carries SLSA build provenance and an SBOM attached at push time.
Inspect manifest, platforms, and labels with:

```bash
docker buildx imagetools inspect ghcr.io/ospp-org/csms-mqtt-bridge:0.1.0
```

Run as you would the locally-built image — see the `docker run` example
above and the [environment variables](#environment-variables) table for
required configuration.

### TLS SNI when connecting via an internal hostname

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
