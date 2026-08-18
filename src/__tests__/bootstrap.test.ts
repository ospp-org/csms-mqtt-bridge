import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { bootstrap } from '../bootstrap.js';
import type { MqttBridge } from '../mqtt.js';
import type { RedisBridge } from '../redis.js';

const makeRedis = (over: Partial<RedisBridge> = {}): RedisBridge =>
  ({
    start: vi.fn((): Promise<void> => Promise.resolve()),
    assertQueueDurable: vi.fn((): Promise<void> => Promise.resolve()),
    pushIncoming: vi.fn(),
    quit: vi.fn(),
    isReady: vi.fn(() => true),
    ...over,
  });

const silent = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('bootstrap — ordered startup', () => {
  it('starts Redis, asserts durability, THEN starts MQTT — in that order', async () => {
    const calls: string[] = [];
    const redis = makeRedis({
      start: vi.fn(() => {
        calls.push('start');
        return Promise.resolve();
      }),
      assertQueueDurable: vi.fn(() => {
        calls.push('assert');
        return Promise.resolve();
      }),
    });
    const startMqtt = vi.fn((): MqttBridge => {
      calls.push('mqtt');
      return {} as MqttBridge;
    });

    await bootstrap({ redis, startMqtt, logger: silent });

    expect(calls).toEqual(['start', 'assert', 'mqtt']);
  });

  // The whole point of the guard: if the queue can evict, the bridge must never
  // reach the broker. A bridge that connects first and dies second has already
  // ack'd — and lost — whatever arrived in the window.
  it('does NOT start MQTT when the durability assertion rejects', async () => {
    const redis = makeRedis({
      assertQueueDurable: vi.fn(() => Promise.reject(new Error('allkeys-lru'))),
    });
    const startMqtt = vi.fn((): MqttBridge => ({}) as MqttBridge);

    await expect(bootstrap({ redis, startMqtt, logger: silent })).rejects.toThrow(/allkeys-lru/);
    expect(startMqtt).not.toHaveBeenCalled();
  });

  it('does NOT start MQTT when Redis fails to connect', async () => {
    const redis = makeRedis({
      start: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    });
    const startMqtt = vi.fn((): MqttBridge => ({}) as MqttBridge);

    await expect(bootstrap({ redis, startMqtt, logger: silent })).rejects.toThrow(/ECONNREFUSED/);
    expect(startMqtt).not.toHaveBeenCalled();
  });

  it('does NOT assert durability when Redis never connected', async () => {
    const assertQueueDurable = vi.fn((): Promise<void> => Promise.resolve());
    const redis = makeRedis({
      start: vi.fn(() => Promise.reject(new Error('down'))),
      assertQueueDurable,
    });
    await expect(
      bootstrap({ redis, startMqtt: () => ({}) as MqttBridge, logger: silent }),
    ).rejects.toThrow();
    expect(assertQueueDurable).not.toHaveBeenCalled();
  });

  it('returns the MQTT bridge on success', async () => {
    const handle = { client: {}, stop: vi.fn() } as unknown as MqttBridge;
    const result = await bootstrap({
      redis: makeRedis(),
      startMqtt: () => handle,
      logger: silent,
    });
    expect(result).toBe(handle);
  });
});
