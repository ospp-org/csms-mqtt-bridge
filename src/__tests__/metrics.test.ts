import { describe, expect, it } from 'vitest';

import { classifyDropReason, register, topicDropsTotal } from '../metrics.js';

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
    expect(rendered).toMatch(/csms_bridge_topic_drops_total\{[^}]*reason="non_compliant_station_id"[^}]*\} \d+/);
    expect(rendered).toMatch(/csms_bridge_topic_drops_total\{[^}]*reason="wrong_topic_format"[^}]*\} \d+/);
    expect(rendered).toMatch(/csms_bridge_topic_drops_total\{[^}]*reason="other"[^}]*\} \d+/);
    // service label is set as a default label on the registry — proves the registry config
    expect(rendered).toMatch(/service="csms-mqtt-bridge"/);
  });
});
