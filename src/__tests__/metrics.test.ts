import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildInfo,
  classifyDropReason,
  register,
  setBuildInfo,
  topicDropsTotal,
} from '../metrics.js';
import { resetState, state } from '../state.js';

describe('classifyDropReason', () => {
  it.each<[string, ReturnType<typeof classifyDropReason>]>([
    // non_compliant_station_id: shape matches stations namespace + to-server suffix,
    // but the inner stationId fails the hex regex (or other STATION_TOPIC_RE constraint)
    ['ospp/v1/stations/STN_BAD/to-server', 'non_compliant_station_id'],
    ['ospp/v1/stations/stn_smoke12345678/to-server', 'non_compliant_station_id'],
    ['ospp/v1/stations/stn_short/to-server', 'non_compliant_station_id'],
    ['ospp/v1/stations//to-server', 'non_compliant_station_id'],

    // wrong_topic_format: stations namespace but suffix is wrong
    ['ospp/v1/stations/stn_00000001/to-server/extra', 'wrong_topic_format'],
    ['ospp/v1/stations/stn_00000001/to-station', 'wrong_topic_format'],
    ['ospp/v1/stations/stn_00000001', 'wrong_topic_format'],

    // other: not in stations namespace at all
    ['random/garbage/topic', 'other'],
    ['ospp/v2/stations/stn_00000001/to-server', 'other'],
    ['ospp/v1/servers/abc/status', 'other'],
    ['', 'other'],
  ])('classifies "%s" as %s', (topic, expected) => {
    expect(classifyDropReason(topic)).toBe(expected);
  });
});

describe('topicDropsTotal counter', () => {
  it('is registered in the bridge registry and exposes the expected metric name + labels', async () => {
    // Bump the counter for each known reason so the rendered output is deterministic.
    topicDropsTotal.inc({ reason: 'non_compliant_station_id' });
    topicDropsTotal.inc({ reason: 'wrong_topic_format' }, 2);
    topicDropsTotal.inc({ reason: 'other' }, 3);

    const rendered = await register.metrics();
    expect(rendered).toContain('# HELP csms_bridge_topic_drops_total');
    expect(rendered).toContain('# TYPE csms_bridge_topic_drops_total counter');
    expect(rendered).toMatch(
      /csms_bridge_topic_drops_total\{[^}]*reason="non_compliant_station_id"[^}]*\} \d+/,
    );
    expect(rendered).toMatch(
      /csms_bridge_topic_drops_total\{[^}]*reason="wrong_topic_format"[^}]*\} \d+/,
    );
    expect(rendered).toMatch(/csms_bridge_topic_drops_total\{[^}]*reason="other"[^}]*\} \d+/);
    // service label is set as a default label on the registry — proves the registry config
    expect(rendered).toMatch(/service="csms-mqtt-bridge"/);
  });
});

// The bridge's running version was invisible from outside the process: it was logged
// once at startup and never exposed. That is how a stack ran image 0.1.5 — carrying
// AUDIT-05 F-02 on both halves — while the fix sat tagged at v0.1.7, with nothing to
// alert on. A build_info gauge makes the deployed version a queryable series, so
// version drift is detectable rather than archaeological.
describe('build info', () => {
  it('exposes the running version as a labelled series', async () => {
    setBuildInfo('9.9.9');
    const rendered = await register.metrics();
    expect(rendered).toContain('# TYPE csms_bridge_build_info gauge');
    expect(rendered).toMatch(/csms_bridge_build_info\{[^}]*version="9\.9\.9"[^}]*\} 1/);
  });

  it('keeps exactly one version series when called again (no stale version lingering)', async () => {
    setBuildInfo('1.1.1');
    setBuildInfo('2.2.2');
    const rendered = await register.metrics();
    const lines = rendered.split('\n').filter((l) => l.startsWith('csms_bridge_build_info{'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('version="2.2.2"');
  });

  it('is registered on the bridge registry, not the prom-client global default', () => {
    // Assert presence FIRST: without this, both sides are undefined when the metric
    // does not exist and the identity check passes vacuously.
    expect(buildInfo).toBeDefined();
    expect(register.getSingleMetric('csms_bridge_build_info')).toBe(buildInfo);
  });
});

// state.ts tracked its fields and exported none of them. redisConnected and
// lastMessageReceivedAt had NO reader anywhere — written on
// every event and observable by nothing. So the one failure that freezes the whole
// fleet (Redis down, ingest wedged, process alive) was invisible to Prometheus.
// These gauges are the readers; they are collected at scrape time, not cached.
describe('bridge state gauges', () => {
  it('renders the MQTT and Redis connection state and the reconnect count at scrape time', async () => {
    resetState();
    state.mqttConnected = true;
    state.redisConnected = false;
    state.reconnectCount = 7;

    const rendered = await register.metrics();
    expect(rendered).toMatch(/csms_bridge_mqtt_connected\{[^}]*\} 1/);
    expect(rendered).toMatch(/csms_bridge_redis_connected\{[^}]*\} 0/);
    expect(rendered).toMatch(/csms_bridge_reconnects_total\{[^}]*\} 7/);
  });

  it('reflects a CHANGE in state on the next scrape (not frozen at first collect)', async () => {
    resetState();
    state.mqttConnected = false;
    let rendered = await register.metrics();
    expect(rendered).toMatch(/csms_bridge_mqtt_connected\{[^}]*\} 0/);

    state.mqttConnected = true;
    rendered = await register.metrics();
    expect(rendered).toMatch(/csms_bridge_mqtt_connected\{[^}]*\} 1/);
  });

  it('reports last-message age, and -1 when nothing has arrived', async () => {
    resetState();
    let rendered = await register.metrics();
    expect(rendered).toMatch(/csms_bridge_last_message_age_seconds\{[^}]*\} -1/);

    state.lastMessageReceivedAt = new Date(Date.now() - 12_000);
    rendered = await register.metrics();
    const match = /csms_bridge_last_message_age_seconds\{[^}]*\} (\d+)/.exec(rendered);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(11);
  });
});

// The README's `GET /metrics` table is what an operator reads to learn which series a
// scrape returns, and it drifted: removing the outbound path took
// csms_bridge_inflight_outbound out of the registry and left its row in the table. Pinned
// both ways, on name, type and label names: a row with no metric behind it, and a metric
// with no row. Every bridge metric is declared in src/metrics.ts, imported above.
describe('README metrics table', () => {
  const readmeRows = (): string[] => {
    const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf-8');
    return readme.split('\n').flatMap((line) => {
      const row = /^\| `(csms_bridge_[a-z_]+)(\{[^}]*\})?` +\| ([a-z]+) +\|/.exec(line);
      return row ? [`${row[1] ?? ''}${row[2] ?? ''} ${row[3] ?? ''}`] : [];
    });
  };

  // prom-client's typings omit labelNames and declare `type` as a numeric enum; at run
  // time every metric carries its labelNames and a type string ('counter', 'gauge').
  const registeredRows = (): string[] =>
    register
      .getMetricsAsArray()
      .map((m) => m as unknown as { name: string; type: string; labelNames: readonly string[] })
      .filter((m) => m.name.startsWith('csms_bridge_'))
      .map((m) => {
        const labels = m.labelNames.length > 0 ? `{${m.labelNames.join(',')}}` : '';
        return `${m.name}${labels} ${m.type}`;
      });

  it('lists exactly the csms_bridge_* metrics the registry exposes, with their type and labels', () => {
    const registered = registeredRows();
    // The denominator first: two empty lists are equal, and that would prove nothing.
    expect(registered.length).toBeGreaterThan(0);
    expect(readmeRows().sort()).toEqual(registered.sort());
  });
});
