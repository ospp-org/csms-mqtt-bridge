# Redis queue contract — `csms-mqtt-bridge` ↔ csms-server

This is the authoritative schema for the envelopes that flow over the Redis
queues between `csms-mqtt-bridge` (this service) and the csms-server
worker (`php artisan mqtt:consume` — a standalone long-running command in its
own container, NOT a Horizon job).

Both sides MUST agree on this contract. Bridge is the producer for
`mqtt:incoming` and the consumer for `mqtt:outgoing`; the csms-server
worker is the opposite.

---

## 1. Versioning

Every envelope carries an integer `version` field. The current value is
**`1`**.

- A consumer that reads an envelope with `version` field absent or with a
  value other than the one it understands MUST reject the envelope and
  log a clear error. It MUST NOT silently coerce or guess.
- An incompatible schema change (renaming a field, changing a field's
  type, removing a required field) MUST bump `version`. Adding a new
  optional field is non-breaking and does not require a bump.
- During a version transition both sides may choose to accept multiple
  versions for a deployment window, but each accepted version's shape
  MUST be preserved exactly.

The bridge enforces this in `src/redis.ts` (`parseOutgoingEnvelope`); the
canonical version constant is exported as `ENVELOPE_VERSION` from the
same module.

---

## 2. Queue keys

| Key               | Direction                | Producer            | Consumer                                      |
| ----------------- | ------------------------ | ------------------- | --------------------------------------------- |
| `mqtt:incoming`   | broker → bridge → worker | bridge (LPUSH)      | csms-server worker (`BLMOVE … RIGHT LEFT`)    |
| `mqtt:outgoing`   | worker → bridge → broker | csms-server worker  | bridge (BLMOVE → `mqtt:processing`)           |
| `mqtt:processing` | bridge-internal          | bridge (BLMOVE dst) | bridge (LREM after PUBACK; LRANGE on startup) |

Keys are configurable via `REDIS_QUEUE_INCOMING`, `REDIS_QUEUE_OUTGOING`,
and `REDIS_QUEUE_PROCESSING` env vars on the bridge side; csms-server's
worker must read the same names for the first two from its config.
`mqtt:processing` is bridge-internal — the worker should NOT touch it.

`mqtt:processing` is currently a singleton, which is correct for
single-instance deployments. Multi-instance HA (Phase F.7) will need
per-instance suffixing (e.g. `mqtt:processing:csms-uat-server-1`) so that
two bridges don't steal each other's in-flight messages.

## 2.1. Redis server requirements

- **Version**: ≥ 6.2 (BLMOVE since 6.2.0). `redis:7.x` is the tested target
  and matches what `csms-server`'s compose runs.
- **Auth**: production runs with `--requirepass`; bridges use
  `redis://[:password]@host:port` URLs. TLS via `rediss://` is supported.
- **Persistence**: AOF (`--appendonly yes`) is strongly recommended. With
  AOF, the at-least-once guarantee survives a Redis restart — without it,
  `mqtt:processing` and `mqtt:outgoing` items disappear on Redis crash and
  the at-least-once contract degrades to "at-most-once with replay
  best-effort".
- **Memory policy**: `noeviction` is REQUIRED, and both sides now enforce it.
  Under an eviction policy an `LPUSH` reports success, the bridge PUBACKs, the
  broker drops its copy, and Redis discards the entry — the message is lost on
  both sides with no error, no log and no redelivery. Measured against a real
  redis:7-alpine at a 3 MB cap: `allkeys-lru` → 400 pushes, 400 acked, 0 rejected,
  16 surviving; `noeviction` → the overflow rejected with `OOM command not
  allowed`, the ack withheld, and acked == surviving exactly.

  The bridge refuses to start unless the queue Redis reports `noeviction`
  (`assertQueueDurable()`, overridable only via `REDIS_REQUIRE_NOEVICTION=false`);
  csms-server's worker refuses likewise
  (`MqttConsume::assertQueueRedisDurable()`). Both must resolve to the SAME
  instance — the dedicated `redis-queue`, not the shared `allkeys-lru` cache
  Redis. The bridge writes the queue and the worker reads it; they have to
  rendezvous, and only the environment makes that true.

---

## 3. Inbound envelope — `mqtt:incoming`

Pushed by the bridge for every MQTT publish that arrives on the PLAIN
(non-shared) subscription `ospp/v1/stations/+/to-server`. The subscription is
deliberately not `$share/`: EMQX does not queue a shared subscription's messages
for an offline member, so a bridge restart dropped them (AUDIT-05 F-02, fixed
forward in `2ba00e8`).

The worker consumes with `BLMOVE <incoming> <pending> RIGHT LEFT` into a
per-worker pending list. Popping from the RIGHT against an `LPUSH` producer is
FIFO — verified against a real Redis, oldest message first.

### TypeScript schema (`src/redis.ts`)

```ts
export interface IncomingEnvelope {
  version: 1;
  topic: string;             // full MQTT topic the message arrived on
  stationId: string;         // extracted from topic
  payload: string;           // base64 of the original payload bytes
  qos: 0 | 1 | 2;            // QoS at which the broker delivered
  receivedAt: string;        // ISO 8601 with millisecond precision, UTC
  messageId: string;         // RFC 4122 v4 UUID, generated by the bridge
  properties: Record<string, unknown> | null;  // MQTT 5 properties
}
```

### Field semantics

- **`version`** (required) — `1`. See §1.
- **`topic`** (required) — full topic string as observed by the bridge,
  matching the regex
  `^ospp/v1/stations/stn_[a-f0-9]{8,60}/to-server$` (per
  spec/spec/01-architecture.md:127). Topics that don't match are
  dropped with a `warn` log; they NEVER reach this queue.
- **`stationId`** (required) — extracted from `topic`. Always equal to
  the captured group, including the `stn_` prefix. Provided
  explicitly so the worker doesn't have to re-parse the topic.
- **`payload`** (required) — base64-encoded bytes of the original MQTT
  payload. The bridge does not interpret or alter payload bytes;
  base64 keeps the envelope JSON-safe even for binary payloads. The
  worker decodes with `base64_decode($payload)`.
- **`qos`** (required) — QoS level the broker delivered at, taken from
  the PUBLISH packet. Worker may use this for diagnostics or to enforce
  policy (e.g., reject QoS 0 in tests).
- **`receivedAt`** (required) — bridge wall clock at the moment of
  packet receipt, ISO 8601, UTC, millisecond precision (e.g.
  `"2026-04-28T08:01:23.456Z"`). Useful for end-to-end latency
  measurement and for ordering when needed (single bridge instance →
  monotonic per stationId).
- **`messageId`** (required) — RFC 4122 v4 UUID generated by the bridge,
  **fresh on every delivery**. This is bridge-internal, not the MQTT packet
  identifier, and it is **NOT a deduplication key** — see §5. It identifies one
  delivery attempt, which makes it useful for tracing a single envelope through
  the logs and nothing else. A broker re-delivery of the identical packet gets a
  DIFFERENT value here.
- **`properties`** (required, may be `null`) — MQTT 5 properties from
  the PUBLISH packet, passed through verbatim. `null` if the broker
  did not include any. Examples of properties the worker may see:
  `contentType`, `correlationData`, `responseTopic`, `userProperties`.
  Note: `correlationData` arrives as a Buffer in the MQTT.js packet —
  if it is present in `properties`, it has been JSON-serialized to a
  base64 string already, NOT the raw Buffer.

### Example

```json
{
  "version": 1,
  "topic": "ospp/v1/stations/stn_00000001/to-server",
  "stationId": "stn_00000001",
  "payload": "eyJ0eXBlIjoiQm9vdE5vdGlmaWNhdGlvbiJ9",
  "qos": 1,
  "receivedAt": "2026-04-28T08:01:23.456Z",
  "messageId": "38376856-df9f-4eda-b3b6-771ab9e55655",
  "properties": { "contentType": "application/json" }
}
```

`atob("eyJ0eXBlIjoiQm9vdE5vdGlmaWNhdGlvbiJ9")` → `{"type":"BootNotification"}`

---

## 4. Outgoing envelope — `mqtt:outgoing`

The bridge consumes with `BLMOVE <outgoing> <processing> LEFT RIGHT`, decodes
the base64 payload, and publishes via its persistent mTLS MQTT 5 connection.

> **This direction has no producer.** Nothing in csms-server writes
> `mqtt:outgoing`; server→station traffic goes over the EMQX REST API
> (`EmqxApiPublisher` → `POST /api/v5/publish`). The schema below describes what
> the bridge WOULD accept, not a path that carries traffic today.

### TypeScript schema (`src/redis.ts`)

```ts
export interface OutgoingEnvelope {
  version: 1;
  topic: string;             // full MQTT topic to publish to
  payload: string;           // base64 of the bytes to publish
  qos: 0 | 1 | 2;
  properties?: Record<string, unknown>;  // optional MQTT 5 properties
}
```

### Field semantics

- **`version`** (required) — `1`. Bridge rejects unknown versions.
- **`topic`** (required) — full MQTT topic. The bridge does NOT validate
  the topic shape against the OSPP `to-station` pattern at this layer;
  validation lives upstream (the worker building the envelope is
  expected to construct legal topics, e.g.
  `ospp/v1/stations/{stationId}/to-station`).
- **`payload`** (required) — base64 of the bytes to publish. Worker
  must base64-encode before pushing (`base64_encode($bytes)`).
- **`qos`** (required) — desired publish QoS. Bridge passes this
  through to mqtt.js.
- **`properties`** (optional) — MQTT 5 properties to attach. Same shape
  as the inbound envelope's `properties`. Pass `userProperties` as
  `{ key: string|string[] }` per MQTT 5 spec.

### Example

```json
{
  "version": 1,
  "topic": "ospp/v1/stations/stn_00000001/to-station",
  "payload": "eyJhY3Rpb24iOiJCb290Tm90aWZpY2F0aW9uUmVzcG9uc2UiLCJzdGF0dXMiOiJBY2NlcHRlZCJ9",
  "qos": 1,
  "properties": { "contentType": "application/json" }
}
```

`atob(...)` → `{"action":"BootNotificationResponse","status":"Accepted"}`

### Rejection cases (bridge-side)

The bridge's `parseOutgoingEnvelope` rejects (with a `warn` log; the
loop continues with the next envelope):

- non-object root, or root is `null`
- missing or non-`1` `version`
- missing or empty `topic`
- non-string `payload`
- `qos` not in `{0, 1, 2}`
- `properties` present but not an object (or `null`)

---

## 5. Reliability semantics

The bridge is at-least-once in both directions as of Phase 0.5. Workers
MUST be prepared to see the same `messageId` more than once and dedupe
via that field if their downstream side effects are not idempotent.

### Inbound: broker → bridge → Redis

The bridge overrides `client.handleMessage`, so the PUBACK to the broker
is sent only after `LPUSH mqtt:incoming` resolves. On Redis failure, the
bridge calls the mqtt.js callback with an error → mqtt.js skips the
PUBACK → the broker keeps the message and re-delivers it on session reconnect.

Note the shape of "Redis failure" here. A Redis that is DOWN does not produce an
error: with `maxRetriesPerRequest: null` the push neither resolves nor rejects,
and because mqtt.js pumps inbound packets strictly one at a time, ingest simply
stops until Redis returns — nothing is acked, so nothing is lost. The rejection
path above is reached by Redis answering with an ERROR (`OOM` under `noeviction`,
ACL, WRONGTYPE), and it is counted as
`csms_bridge_inbound_push_failures_total`.

A message on an unrecognized topic (failing the
`^ospp/v1/stations/stn_[a-f0-9]{8,60}/to-server$` regex) is **dropped
and acked**: re-delivering a malformed topic on every reconnect is worse
than dropping it. The drop is logged at `warn`.

### Outbound: worker → Redis → bridge → broker

The bridge consumes outbound with `BLMOVE mqtt:outgoing mqtt:processing
LEFT RIGHT`. Once the broker confirms the publish (PUBACK for QoS 1 /
PUBCOMP for QoS 2), the bridge removes the same raw JSON string from
`mqtt:processing` with `LREM mqtt:processing 1 <raw>`.

If the bridge crashes between BLMOVE and a successful PUBACK, the raw
envelope is still in `mqtt:processing`. On the next startup, the bridge
calls `LRANGE mqtt:processing 0 -1`, parses each item, and republishes
+ acks. Failed replays stay in `mqtt:processing` for the next attempt.

If the bridge encounters a malformed envelope (during BLMOVE-then-parse
or during startup replay), it removes the bad raw string from
`mqtt:processing` (`LREM`) and logs an error. We don't replay garbage
forever.

### Worker requirements

- **Idempotency: dedupe on the OSPP `messageId` INSIDE the decoded payload —
  never on the envelope's `messageId`.**

  The envelope `messageId` is minted fresh by the bridge on every delivery. In
  the precise scenario that produces duplicates — the broker re-delivering
  because the bridge crashed before acking — the re-delivered envelope carries a
  DIFFERENT `messageId`, so a dedupe keyed on it matches nothing and every
  duplicate is processed twice. An earlier revision of this document prescribed
  exactly that; it was wrong. csms-server never followed it, which is why the
  defect was only ever on paper.

  Decode `payload`, read the OSPP `messageId` from the message, and key on
  `(stationId, osppMessageId)`. That value is stable across re-deliveries because
  the station chose it. csms-server does this at
  `MessageDispatcher.php:219` via `MessageFactory.php:109`, backed by
  `DeduplicationRegistry` (a DONE marker, an owned `SET NX EX` claim, and a
  cached response).

  The envelope `messageId` is still worth logging — together the two
  distinguish a broker re-delivery (same OSPP id, different envelope id) from an
  application-level duplicate (both the same).
- **At-least-once is expected, exactly-once is not provided.** The
  bridge does not (and cannot, against an MQTT broker) guarantee
  exactly-once delivery; the worker must tolerate duplicates.

---

## 6. Compatibility checklist for the csms-server worker (Phase 0.8)

When implementing the consumer side:

- [ ] Read `mqtt:incoming` from the RIGHT (FIFO against the bridge's `LPUSH`).
  A reliable-queue `BLMOVE <incoming> <pending> RIGHT LEFT` is preferred over a
  destructive `BRPOP`, so a crash mid-handler does not drop the envelope.
- [ ] Reject any envelope where `version !== 1`.
- [ ] `base64_decode($payload)` to recover original payload bytes.
- [ ] Dedupe on the OSPP `messageId` inside the decoded payload, keyed with
  `stationId`. Do **NOT** use the envelope `messageId` — it is regenerated on
  every delivery and cannot match a re-delivery. See §5.
- [ ] Use `receivedAt` for end-to-end latency metrics, and log the envelope
  `messageId` as a per-delivery trace id.
- [ ] Outbound does not use this queue today — responses go over the EMQX REST
  API. If that ever changes, write to `mqtt:outgoing` with `RPUSH`,
  `version: 1`, base64-encoded payload, and a topic that follows
  `ospp/v1/stations/{stationId}/to-station`.
- [ ] Do NOT touch `mqtt:processing` — that is bridge-internal.
- [ ] Don't include MQTT packet IDs or session-specific fields — the
  bridge is responsible for those.
