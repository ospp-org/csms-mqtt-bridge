import { Counter, Registry, collectDefaultMetrics } from 'prom-client';

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
 *     misconfig (shared subscription pattern is wrong, ACL bypass, etc).
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
