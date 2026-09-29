# ADR-0001 — Remove the Redis outbound path

**Status:** Accepted · **Date:** 2026-08-18 · **Supersedes:** the outbound half of
`docs/REDIS-QUEUE-CONTRACT.md` §2/§4/§5 as they stood before this date.

## Context

The bridge shipped with two directions. Inbound (broker → `mqtt:incoming` → csms-server)
carries every message from every station. Outbound (`mqtt:outgoing` → `mqtt:processing` →
broker) carried nothing, ever.

Established, each verified directly rather than inherited:

- **No producer has ever existed.** `grep -rn "mqtt:outgoing"` across csms-server's
  `app/`, `config/`, `database/`, `routes/`, `tests/` returns **0**. `git log -S
  "mqtt:outgoing" --all` returns **4 commits, all touching only `.md` files** —
  `11751f1`, `f0c8e25`, `7173e4b` (2026-04-28/29) and `18141ed` (2026-07-07).
- **The REST publisher is the incumbent, not the stopgap.**
  `app/Shared/MQTT/EmqxApiPublisher.php` landed **2026-02-22** (`53222f1`), two months
  before this repo's first commit (`f3ad11b`, 2026-04-28), and kept receiving fixes for
  three months *after* the outbound half was built (`fa244a5`, `cde03d7` 2026-05-11;
  `5973f85` 2026-07-23).
- **"Phase 0.9" was named once and never revisited.**
  `docs/PHASE-0.8-IMPLEMENTATION.md` ("1. Architecture at a glance", bullet "Outbound responses still
  use the EMQX REST API"; "6. Known limitations carried forward", bullet "Phase 0.9 — outbound through
  `mqtt:outgoing`") queues the migration; `git log` on that file
  shows **one commit, `7173e4b`, 2026-04-29**. Its sibling Phase 0.10 (webhook retirement)
  *was* executed, in `2594e88` 2026-05-16 — the roadmap was live and 0.9 was passed over.
- **Later documents treat REST as settled architecture**, with no migration caveat:
  `docs/remediation/UAT-ACTIVATION-20260705.md`, "3.2 Lockstep (both halves)" of "STEP 3 — B6 dedicated
  `redis-queue` (pipe-M3) — ACTIVATED + PROVEN", bullet "Architecture note" ("outbound was never at risk"),
  `docs/audits/AUDIT-05-concurrency-distributed-state.md`, "What I checked and found clean", bullet "The active
  outbound server path is EMQX REST, not the bridge's Redis outgoing queue" (a formal concurrency audit
  consciously excluding the queue as inactive machinery), `docs/PROJECT-STATUS.md`, "MQTT Protocol", bullet
  "Transport: EmqxApiPublisher".
- Compose sets no `REDIS_QUEUE_OUTGOING` or `REDIS_QUEUE_PROCESSING` in any environment.
  The loop ran entirely on defaults no deployer ever configured.

## Decision

Delete the outbound path — the loop, the queues, the envelope **types**, the config keys,
the state field, and its tests. Retract the corresponding contract sections.

## What is lost

| Removed | Where |
| --- | --- |
| `popOutgoingReliable`, `replayProcessing`, `parseOutgoingEnvelope`, `ackOf` | `src/redis.ts` |
| `OutgoingEnvelope`, `ReliableOutgoing` types | `src/redis.ts` |
| the dedicated `duplicate()` ioredis client | `src/redis.ts` |
| `publishEnvelope`, `startOutboundLoop`, `replayProcessingOnce` | `src/mqtt.ts` |
| `REDIS_QUEUE_OUTGOING`, `REDIS_QUEUE_PROCESSING`, `REDIS_BLPOP_TIMEOUT_SEC` | `src/config.ts` |
| `state.inflightOutbound` + `csms_bridge_inflight_outbound` | `src/state.ts`, `src/metrics.ts` |
| **47 tests** (198 → 151) | `src/__tests__/` |

~1,050 lines. The second ioredis client deserves a note: it was added in `44f81d1`
*solely* to stop the outbound `BLMOVE` head-of-line-blocking inbound `LPUSH`. With
outbound gone, the problem it solved cannot occur, so the fix goes with it.

## Why the types were deleted too, rather than kept as a starting point

This is the part worth re-reading in six months, because keeping them looks harmless.

**The schema could not carry today's traffic.** `OutgoingEnvelope` was
`{ version, topic, payload, qos, properties? }`. `MqttStationGateway::publish()` passes
`retain` on **every** publish — there was no `retain` field. It also passes
`messageExpiryInterval` and `correlationData`, which had nowhere defined to sit;
`properties` documented only `userProperties` as an example. So the schema was already
wrong for the only caller that would ever have produced it. Reviving this direction needs
a `version: 2`, not this shape.

**A shape that looks authoritative is worse than no shape.** Someone finding
`OutgoingEnvelope` in six months would reasonably assume it was validated against a real
producer. It never was. Keeping a type nobody can implement correctly is how a wrong
starting point survives a rewrite it should not have survived.

**The error semantics invert, so the call sites cannot be ported mechanically.**
`EmqxApiPublisher::publish()` throws `PublishFailedException` **synchronously** when the
broker or API is unreachable, and callers depend on that:
`DashboardDeviceController::failureReason()` surfaces it to the operator,
`StopAllStationSessionsAction::execute()` handles it in the stop-all leg,
`CheckKeyExpiryCommand::triggerRenewal()` reasons about it. An `RPUSH` succeeds whether or not the
broker is reachable. Moving outbound to a queue silently deletes the failure signal from
all three unless an async delivery-result channel is built first — and none exists.

## What a revival would need

The swap surface itself is small: one private method, `MqttStationGateway::publish()`,
which all three public entry points funnel through. Everything above it — signing, topic
resolution, the ADR-0004 disabled-station gate, `PendingCommandRegistry` — is
transport-agnostic. What is *not* small:

1. Envelope v2 carrying `retain`, `messageExpiryInterval`, `correlationData`.
2. An async delivery-result channel, to replace the synchronous throw (above).
3. A per-instance processing key + lease/reaper, mirroring what inbound already has
   (`{pending}:{workerId}` + heartbeat + `IngressLeaseReaper`). The bridge's
   `mqtt:processing` was a singleton; a second instance would steal in-flight messages.
4. Ordering: one shared list drained by N replicas has no partition key, so per-station
   order — preserved today by one blocking HTTP call per publish — is lost.
5. The queue on a `noeviction` instance, as a hard precondition, not an option.
6. Outbound deduplication, which does not exist today. At-least-once queue delivery plus
   a boot-time replay means duplicate publishes, and each duplicate is a real command on
   the wire.

## OPEN — the non-compliance verdict is NOT closed by this ADR

`csms-server/AUDIT-UAT-PROD-MIRROR.md`, §1.3 "Architectural decision: pure mTLS, sidecar MQTT subscriber"
(2026-04-28), states:

> The current csms-server uses `EmqxApiPublisher` (POST `/api/v5/publish` to EMQX REST
> API) for outbound and HTTP webhook for inbound. This is **sandbox pattern**, not
> OSPP-compliant.

The inbound half of that judgement was acted on — this bridge exists because of it, and
the webhook path was retired in `2594e88`. **The outbound half was never answered.** It
stands unamended at HEAD.

Deleting the alternative does not answer it. It removes the option, which can read as
resolution — and that is precisely the failure mode this section exists to prevent. If
the verdict holds, the consequence is large: the mechanism by which the server sends
**every command to every station** would be non-conformant. That is not a decision a
bridge-side ADR can make, and this ADR does not make it.

**What would settle it,** either way:

- A finding on whether OSPP actually constrains the server→station transport at all.
  Note the spec is weaker here than §1.3 assumes: `spec/02-transport.md`, section 2.3
  Server Subscription Patterns, says the server **SHOULD** use shared subscriptions, and
  `spec/01-architecture.md`, section 8 Scope and Boundaries (its Deployment Topology row),
  places deployment topology explicitly outside OSPP's scope. Neither text names a required
  *publish* mechanism.
- If it does not, an amendment retracting the "not OSPP-compliant" clause for outbound.
- If it does, a plan — at which point the six items above are the cost, and this ADR is
  the record of why the deleted code would not have shortened it.

Owner: csms-server. This repo cannot amend that document.

## Conscious divergence — plain subscription, recorded so it is not re-reported

Related, and recorded here for the same reason: the bridge subscribes to
`ospp/v1/stations/+/to-server` **plainly**, not `$share/ospp-servers/...`, and this is
deliberate.

`spec/02-transport.md`, section 2.3 Server Subscription Patterns, says the server
**SHOULD** use shared subscriptions; its section 7.3 Shared Subscriptions claims they give
"High availability — if one server fails, messages are
routed to surviving servers."

**That benefit does not hold for a single-member group, and was measured not to.**
On-wire UAT proof under AUDIT-05 F-02 showed EMQX drops matching QoS-1 messages as
`no_subscriber` when the lone group member is offline — a shared subscription is not
retained for an absent member. A plain subscription on a persistent session
(`clean:false` + `sessionExpiryInterval`) **is** queued by the broker and redelivered on
reconnect. Fixed forward in `2ba00e8`.

`$share/` bought nothing here — it load-balances across N consumers and there is one. HA
is unaffected: run N bridges, each with its own clientId and a plain subscription; every
instance receives every message, and csms-server's per-station dedup (AUDIT-05 F-04)
suppresses the duplicates where that guarantee is already proven.

This is a deviation from a **SHOULD**, with a measured cause and no loss of the stated
benefit. It is not a defect. A future audit finding a plain subscription should read this
before filing one.

## Consequences

- 28% of a production component's test suite no longer guards unreachable code.
- `docs/REDIS-QUEUE-CONTRACT.md` is now a one-directional contract, and its §6 checklist
  no longer asks csms-server for a producer that would never be written.
- Reviving outbound starts from the six items above, honestly costed, instead of from a
  schema that could not have worked.
- Recoverable in full from git at `8947e8f` if this decision is ever reversed — but the
  reason to reverse it should come from the OPEN section, not from the code.
