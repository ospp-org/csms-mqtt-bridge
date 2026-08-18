import type { RedisBridge } from './redis.js';
import { state } from './state.js';

export interface HealthChecks {
  /** Attached to the broker — the CONNACK arrived and no close/offline since. */
  mqttConnected: boolean;
  /** Both ioredis clients report ready, so the queue can actually be written. */
  redisReady: boolean;
}

export interface HealthReport {
  status: 'ok' | 'unhealthy';
  checks: HealthChecks;
  /** Seconds since the last inbound message, or null if none has arrived yet. */
  lastMessageAgeSeconds: number | null;
  reconnectCount: number;
}

export interface HealthDeps {
  redis: Pick<RedisBridge, 'isReady'>;
}

/**
 * The two questions a health probe on this process has to answer: is the bridge
 * attached to the broker, and can it write to the queue. Nothing else it does
 * matters if either is false.
 *
 * Previously /healthz returned 200 unconditionally, so a bridge with no broker
 * connection and no Redis reported exactly the same as a working one. That is the
 * failure this closes: a Redis outage freezes ingest for the entire fleet — mqtt.js
 * pumps inbound packets strictly one at a time and cannot advance past a push that
 * never resolves — while the process stays alive and every layer reported healthy.
 *
 * `lastMessageAgeSeconds` is reported but deliberately NOT part of the verdict: a
 * quiet fleet is not a broken bridge, and a probe that fails on silence would flap
 * on a 4-station deployment averaging ~100 messages a day. It is here so an operator
 * (or an alert) can distinguish "connected and idle" from "connected and wedged"
 * without the probe making that judgement itself.
 */
export const buildHealthReport = ({ redis }: HealthDeps): HealthReport => {
  const checks: HealthChecks = {
    mqttConnected: state.mqttConnected,
    redisReady: redis.isReady(),
  };

  const last = state.lastMessageReceivedAt;

  return {
    status: checks.mqttConnected && checks.redisReady ? 'ok' : 'unhealthy',
    checks,
    lastMessageAgeSeconds: last === null ? null : Math.floor((Date.now() - last.getTime()) / 1000),
    reconnectCount: state.reconnectCount,
  };
};

export const healthStatusCode = (report: Pick<HealthReport, 'status'>): 200 | 503 =>
  report.status === 'ok' ? 200 : 503;
