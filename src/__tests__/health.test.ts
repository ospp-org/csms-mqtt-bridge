import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHealthReport, healthStatusCode } from '../health.js';
import type { RedisBridge } from '../redis.js';
import { resetState, state } from '../state.js';

const redisWith = (ready: boolean): Pick<RedisBridge, 'isReady'> => ({
  isReady: vi.fn(() => ready),
});

beforeEach(() => {
  resetState();
});

// /healthz returned 200 unconditionally. A Redis outage freezes ingest for the whole
// fleet — mqtt.js pumps inbound packets one at a time and the pump cannot advance
// until a push resolves — and every layer still reported healthy. This makes the
// route answer the only two questions that matter: is the bridge attached to the
// broker, and can it write to the queue.
describe('buildHealthReport', () => {
  it('is ok only when BOTH the broker connection and the queue are usable', () => {
    state.mqttConnected = true;
    const report = buildHealthReport({ redis: redisWith(true) });
    expect(report.status).toBe('ok');
    expect(report.checks).toEqual({ mqttConnected: true, redisReady: true });
  });

  it.each<[string, boolean, boolean]>([
    ['broker down', false, true],
    ['queue unusable', true, false],
    ['both down', false, false],
  ])('is unhealthy when %s', (_label, mqttConnected, redisReady) => {
    state.mqttConnected = mqttConnected;
    const report = buildHealthReport({ redis: redisWith(redisReady) });
    expect(report.status).toBe('unhealthy');
  });

  it('names WHICH leg is down, so the probe output is actionable', () => {
    state.mqttConnected = false;
    const report = buildHealthReport({ redis: redisWith(true) });
    expect(report.checks.mqttConnected).toBe(false);
    expect(report.checks.redisReady).toBe(true);
  });

  // isReady() existed with no production caller at all. This is the caller.
  it('consults redis.isReady() rather than assuming', () => {
    state.mqttConnected = true;
    const redis = redisWith(true);
    buildHealthReport({ redis });
    expect(redis.isReady).toHaveBeenCalled();
  });

  it('reports unhealthy before startup completes (nothing connected yet)', () => {
    const report = buildHealthReport({ redis: redisWith(false) });
    expect(report.status).toBe('unhealthy');
  });

  it('carries the last-message age so a silent-but-connected bridge is visible', () => {
    state.mqttConnected = true;
    state.lastMessageReceivedAt = new Date(Date.now() - 5_000);
    const report = buildHealthReport({ redis: redisWith(true) });
    expect(report.lastMessageAgeSeconds).toBeGreaterThanOrEqual(4);
    expect(report.lastMessageAgeSeconds).toBeLessThan(60);
  });

  it('reports a null last-message age when nothing has arrived yet', () => {
    state.mqttConnected = true;
    const report = buildHealthReport({ redis: redisWith(true) });
    expect(report.lastMessageAgeSeconds).toBeNull();
  });
});

describe('healthStatusCode', () => {
  it('maps ok to 200 and unhealthy to 503', () => {
    expect(healthStatusCode({ status: 'ok' })).toBe(200);
    expect(healthStatusCode({ status: 'unhealthy' })).toBe(503);
  });

  // A probe that can never fail is the defect. Pin the negative directly.
  it('never returns 200 for an unhealthy report', () => {
    expect(healthStatusCode({ status: 'unhealthy' })).not.toBe(200);
  });
});
