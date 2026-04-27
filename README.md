# csms-mqtt-bridge

Node.js sidecar that bridges the EMQX MQTT broker (mTLS, MQTT 5, shared
subscriptions) and Redis queues for the CSMS server. The CSMS application
(Laravel/PHP) communicates with stations exclusively through this sidecar.

Aligned with the OSPP spec — see `implementors-guide.md:48,227,626,1150`.

## Status

`v0.1.0` — initial scaffold. No business logic yet (Phase 0.3-0.5 of the
parent audit will add config loader, MQTT client wrapper, and Redis bridge).

Phase 0.1 POC validated the chosen stack (`mqtt@5` + Node 22+) against the UAT
EMQX broker via mTLS; round-trip latency was ~469ms with no compatibility issues.

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
- [`vitest`](https://vitest.dev/) — tests
- ESLint flat config + Prettier

## Environment variables

The full set is defined and validated by `src/config.ts` in Phase 0.3.
Placeholder list — final names may change:

| Name              | Required | Description                                             |
|-------------------|----------|---------------------------------------------------------|
| `MQTT_BROKER_URL` | yes      | e.g. `mqtts://mqtt-uat.onestoppay.ro:8884`              |
| `MQTT_CLIENT_ID`  | yes      | Server CN, e.g. `csms-uat-server-1`                     |
| `MQTT_CERT_PATH`  | yes      | PEM path to server cert                                 |
| `MQTT_KEY_PATH`   | yes      | PEM path to server private key                          |
| `MQTT_CA_PATH`    | yes      | PEM path to OneStopPay Root CA (validates broker cert)  |
| `REDIS_URL`       | yes      | e.g. `redis://csms-redis:6379/0`                        |
| `LOG_LEVEL`       | no       | `trace` \| `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `METRICS_PORT`    | no       | Prometheus scrape port (default `9090`)                 |

## Build & run

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

The Dockerfile is multi-stage (deps / builder / runtime) targeting a final
image under 100 MB on `node:22-alpine`. `tini` handles PID 1 signals so SIGTERM
triggers a graceful shutdown.

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
