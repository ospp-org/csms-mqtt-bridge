import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

import { state } from './state.js';

/**
 * Bridge metrics registry.
 *
 * The bridge owns its own Registry instance (rather than mutating the
 * prom-client global default) so test files can be hermetic: importing
 * `metrics.js` from a test does not contaminate state across unrelated tests.
 *
 * `collectDefaultMetrics` is opted in so `/metrics` surfaces standard
 * Node.js process metrics (eventloop lag, GC, heap) in addition to the
 * bridge-specific counters below — same observability shape Prometheus
 * already gets from the Laravel app's exporter.
 */
export const register = new Registry();
register.setDefaultLabels({ service: 'csms-mqtt-bridge' });
collectDefaultMetrics({ register });

/**
 * Inbound MQTT messages that the bridge ack'd to the broker but did NOT
 * push to Redis, because the topic failed the strict OSPP `to-server`
 * regex. Labels classify the failure mode:
 *
 *   non_compliant_station_id — topic shape `ospp/v1/stations/<x>/to-server`
 *     but `<x>` isn't `stn_[a-f0-9]{8,60}`. Almost always operator error
 *     (raw-SQL seeded station with non-hex id; firmware sending malformed
 *     stationId). Worth alerting on.
 *
 *   wrong_topic_format — topic is in `ospp/v1/stations/...` namespace but
 *     doesn't match the full pattern (extra segments, missing `/to-server`
 *     suffix, etc). Indicates client misuse of the topic convention.
 *
 *   other — topic isn't in `ospp/v1/stations/...` at all. Usually broker
 *     misconfig (subscription topic filter is wrong, ACL bypass, etc).
 *
 * The bridge silently dropped these before this counter existed — silent
 * drops were caught only by an operator running a sim and seeing timeouts
 * (see csms-server Sprint Manual Validation Prod report I-1, 2026-05-22).
 */
export const topicDropsTotal = new Counter({
  name: 'csms_bridge_topic_drops_total',
  help: 'Inbound MQTT messages dropped by the bridge (acked without enqueueing). Labels classify why.',
  labelNames: ['reason'] as const,
  registers: [register],
});

export type TopicDropReason = 'non_compliant_station_id' | 'wrong_topic_format' | 'other';

/**
 * Classifies why a topic doesn't match `STATION_TOPIC_RE`. Called only when
 * the parser has already determined the topic is invalid; this routine just
 * decides which bucket the drop falls into for the metric label.
 */
export const classifyDropReason = (topic: string): TopicDropReason => {
  if (!topic.startsWith('ospp/v1/stations/')) {
    return 'other';
  }
  if (topic.endsWith('/to-server')) {
    // Shape matches `ospp/v1/stations/<x>/to-server`. The reason the OUTER
    // regex rejected it must be `<x>` failing the stn_[a-f0-9]{8,60} body.
    return 'non_compliant_station_id';
  }
  // In the stations namespace but the suffix is wrong (extra segments, or
  // not a `to-server` topic at all — e.g. `/to-station`, which the bridge
  // never subscribes to as inbound).
  return 'wrong_topic_format';
};

/**
 * Times the bridge observed a queue Redis whose `maxmemory-policy` is not
 * `noeviction`. Incremented once per startup check that finds a violation —
 * both when the bridge refuses to start (the default) and when
 * REDIS_REQUIRE_NOEVICTION=false downgrades the refusal to a warning.
 *
 * A non-zero value means the queue can be evicted out from under an already-
 * PUBACK'd message: acked to the broker, gone from Redis, invisible to both.
 * This is the one bridge failure mode that loses data without any error.
 */
export const queueDurabilityViolationsTotal = new Counter({
  name: 'csms_bridge_queue_durability_violations_total',
  help: 'Startup checks that found the queue Redis maxmemory-policy != noeviction. Non-zero means inbound messages can be silently evicted after being acked to the broker.',
  labelNames: ['policy'] as const,
  registers: [register],
});

/**
 * Inbound messages whose Redis push FAILED, so the bridge deliberately did not
 * PUBACK and the broker will redeliver. This is the healthy failure: nothing is
 * lost. It exists as a metric because previously the only signal was a log line
 * — and the whole point of the eviction guard is that a rejected write must be
 * loud. A sustained non-zero rate means Redis is rejecting writes (OOM under
 * noeviction, ACL, wrong type); ingest is stalled but intact.
 */
export const inboundPushFailuresTotal = new Counter({
  name: 'csms_bridge_inbound_push_failures_total',
  help: "Inbound messages the bridge failed to enqueue and therefore did NOT ack. Broker will redeliver; nothing is lost.",
  registers: [register],
});

/**
 * The running build, as a queryable series. Always 1; the information is the label.
 *
 * The bridge logged its version once at startup and exposed it nowhere, so a stale
 * image was invisible to everything except someone reading container logs. That is
 * how a stack kept running 0.1.5 — which carries AUDIT-05 F-02 on both halves, a
 * $share/ subscription and no session expiry — while the fix sat tagged at v0.1.7.
 * With this series, `csms_bridge_build_info` can be alerted on directly.
 */
export const buildInfo = new Gauge({
  name: 'csms_bridge_build_info',
  help: 'Running csms-mqtt-bridge build. Always 1; the version label carries the information.',
  labelNames: ['version'] as const,
  registers: [register],
});

/**
 * Publish the running version, replacing any previous one. Resets first so a
 * re-publish cannot leave two version series exposed at once — a metric claiming
 * the process is simultaneously two builds is worse than no metric.
 */
export const setBuildInfo = (version: string): void => {
  buildInfo.reset();
  buildInfo.set({ version }, 1);
};

/**
 * Readers for src/state.ts.
 *
 * Three of its five fields — redisConnected, lastMessageReceivedAt, inflightOutbound
 * — were written on every lifecycle event and read by NOTHING. The bridge's single
 * most damaging runtime condition (Redis unreachable, so the inbound pump cannot
 * advance and ingest is frozen for the whole fleet, while the process stays alive
 * and answers its probe) produced no observable signal at all.
 *
 * Each uses a `collect()` hook so the value is sampled AT SCRAPE TIME. Setting them
 * once at registration would freeze them at their startup values — a gauge that
 * always reads 0 is worse than no gauge, because it looks like an answer.
 */
export const mqttConnectedGauge = new Gauge({
  name: 'csms_bridge_mqtt_connected',
  help: '1 when the bridge holds a live broker connection, 0 otherwise.',
  registers: [register],
  collect() {
    this.set(state.mqttConnected ? 1 : 0);
  },
});

export const redisConnectedGauge = new Gauge({
  name: 'csms_bridge_redis_connected',
  help: '1 when the Redis connection is ready, 0 otherwise. 0 means inbound is stalled: pushes neither resolve nor reject, so no message is acked and the broker retains them.',
  registers: [register],
  collect() {
    this.set(state.redisConnected ? 1 : 0);
  },
});

export const inflightOutboundGauge = new Gauge({
  name: 'csms_bridge_inflight_outbound',
  help: 'Outbound publishes awaiting broker confirmation.',
  registers: [register],
  collect() {
    this.set(state.inflightOutbound);
  },
});

export const reconnectsGauge = new Gauge({
  name: 'csms_bridge_reconnects_total',
  help: 'MQTT reconnect attempts since process start.',
  registers: [register],
  collect() {
    this.set(state.reconnectCount);
  },
});

/**
 * Seconds since the last inbound message, or -1 when none has arrived since start.
 * -1 rather than 0 on purpose: 0 would read as "a message just arrived", which is
 * the opposite of the truth and the more dangerous misreading of the two.
 */
export const lastMessageAgeGauge = new Gauge({
  name: 'csms_bridge_last_message_age_seconds',
  help: 'Seconds since the last inbound message; -1 when none has been received since start.',
  registers: [register],
  collect() {
    const last = state.lastMessageReceivedAt;
    this.set(last === null ? -1 : Math.floor((Date.now() - last.getTime()) / 1000));
  },
});
