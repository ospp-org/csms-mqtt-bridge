import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import { queueDurabilityViolationsTotal, register as metricsRegister } from '../metrics.js';
import { __test__, createRedisBridge } from '../redis.js';

const { retryStrategy } = __test__;

describe('retryStrategy', () => {
  it('returns a positive delay', () => {
    expect(retryStrategy(1)).toBeGreaterThan(0);
    expect(retryStrategy(2)).toBeGreaterThan(0);
  });

  it('grows exponentially up to a 30s cap', () => {
    const d1 = retryStrategy(1);
    const d10 = retryStrategy(10);
    const d20 = retryStrategy(20);
    expect(d10).toBeGreaterThan(d1);
    expect(d20).toBeLessThanOrEqual(30_000 + 200); // cap + jitter
    expect(retryStrategy(100)).toBeLessThanOrEqual(30_000 + 200);
  });
});

// ── createRedisBridge with injected client ─────────────────────────────────

interface FakeRedis {
  status: string;
  connect: ReturnType<typeof vi.fn>;
  lpush: ReturnType<typeof vi.fn>;
  config: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}

const makeFakeRedisClient = (): FakeRedis => ({
  status: 'wait',
  connect: vi.fn((): Promise<void> => Promise.resolve()),
  lpush: vi.fn((_key: string, _value: string): Promise<number> => Promise.resolve(1)),
  config: vi.fn(
    (_op: string, _param: string): Promise<unknown> =>
      Promise.resolve(['maxmemory-policy', 'noeviction']),
  ),
  quit: vi.fn((): Promise<'OK'> => Promise.resolve('OK')),
  on: vi.fn(),
  once: vi.fn(),
  off: vi.fn(),
});

let tmpDir: string;
let validConfig: Config;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `csms-redis-test-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'cert.pem'), 'fake');
  writeFileSync(join(tmpDir, 'key.pem'), 'fake');
  writeFileSync(join(tmpDir, 'ca.pem'), 'fake');

  validConfig = loadConfig({
    MQTT_BROKER_URL: 'mqtts://broker.test:8884',
    MQTT_CLIENT_ID: 'csms-test-server-1',
    MQTT_CERT_PATH: join(tmpDir, 'cert.pem'),
    MQTT_KEY_PATH: join(tmpDir, 'key.pem'),
    MQTT_CA_PATH: join(tmpDir, 'ca.pem'),
    REDIS_URL: 'redis://redis.test:6379',
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('createRedisBridge — start()', () => {
  it('calls client.connect() when status is not ready', async () => {
    const fake = makeFakeRedisClient();
    fake.status = 'wait';
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    await bridge.start();

    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when already ready', async () => {
    const fake = makeFakeRedisClient();
    fake.status = 'ready';
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    await bridge.start();

    expect(fake.connect).not.toHaveBeenCalled();
  });

  it('isReady() reflects status', () => {
    const fake = makeFakeRedisClient();
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    fake.status = 'wait';
    expect(bridge.isReady()).toBe(false);

    fake.status = 'ready';
    expect(bridge.isReady()).toBe(true);
  });
});

describe('createRedisBridge — pushIncoming', () => {
  it('LPUSHes JSON-stringified envelope to the incoming queue', async () => {
    const fake = makeFakeRedisClient();
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    await bridge.pushIncoming({
      version: 1,
      topic: 'ospp/v1/stations/stn_00000001/to-server',
      stationId: 'stn_00000001',
      payload: 'aGVsbG8=',
      qos: 1,
      receivedAt: '2026-04-28T08:00:00.000Z',
      messageId: '00000000-0000-0000-0000-000000000001',
      properties: null,
    });

    expect(fake.lpush).toHaveBeenCalledWith(
      'mqtt:incoming',
      expect.stringContaining('"stationId":"stn_00000001"'),
    );
  });
});

describe('createRedisBridge — quit', () => {
  it('calls client.quit()', async () => {
    const fake = makeFakeRedisClient();
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    await bridge.quit();

    expect(fake.quit).toHaveBeenCalledTimes(1);
  });

  it('tolerates client.quit() rejecting (already-closed connection)', async () => {
    const fake = makeFakeRedisClient();
    fake.quit = vi.fn((): Promise<'OK'> => Promise.reject(new Error('connection already closed')));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    await expect(bridge.quit()).resolves.toBeUndefined();
  });
});

// ── assertQueueDurable — the writer-side eviction guard ────────────────────
//
// The reader (csms-server MqttConsume::assertQueueRedisDurable) already refuses to
// run against an evicting queue Redis. The WRITER had no equivalent, and the writer
// is the side that loses: under `allkeys-lru` an LPUSH reports success, the bridge
// PUBACKs, the broker drops its copy, and Redis evicts the entry. Measured against a
// real Redis: 400 pushes -> 400 resolved, 0 rejected, 16 surviving. Under
// `noeviction` the same run rejects with OOM, the bridge withholds the ack, and
// resolved == surviving exactly.

const durableConfig = (over: Partial<Config> = {}): Config => ({ ...validConfig, ...over });

describe('assertQueueDurable', () => {
  it('resolves when the queue Redis reports noeviction', async () => {
    const fake = makeFakeRedisClient();
    fake.config = vi.fn(() => Promise.resolve(['maxmemory-policy', 'noeviction']));
    const bridge = createRedisBridge(durableConfig(), { client: fake as unknown as Redis });
    // This pinned toBeUndefined(), the same value the downgraded branch below resolved, so
    // no caller could tell an asserted noeviction from a downgraded refusal and bootstrap
    // logged noeviction for both. It resolves with what it found.
    await expect(bridge.assertQueueDurable()).resolves.toEqual({
      durable: true,
      policy: 'noeviction',
    });
    expect(fake.config).toHaveBeenCalledWith('GET', 'maxmemory-policy');
  });

  it('REJECTS when the queue Redis can evict (allkeys-lru)', async () => {
    const fake = makeFakeRedisClient();
    fake.config = vi.fn(() => Promise.resolve(['maxmemory-policy', 'allkeys-lru']));
    const bridge = createRedisBridge(durableConfig(), { client: fake as unknown as Redis });
    await expect(bridge.assertQueueDurable()).rejects.toThrow(/allkeys-lru/);
  });

  it('names the offending policy and the remedy in the error', async () => {
    const fake = makeFakeRedisClient();
    fake.config = vi.fn(() => Promise.resolve(['maxmemory-policy', 'volatile-ttl']));
    const bridge = createRedisBridge(durableConfig(), { client: fake as unknown as Redis });
    await expect(bridge.assertQueueDurable()).rejects.toThrow(/volatile-ttl[\s\S]*noeviction/);
  });

  // Fail CLOSED: an undeterminable policy is treated as unsafe, never as safe.
  it('REJECTS when CONFIG GET returns an unexpected shape', async () => {
    const fake = makeFakeRedisClient();
    fake.config = vi.fn(() => Promise.resolve([]));
    const bridge = createRedisBridge(durableConfig(), { client: fake as unknown as Redis });
    await expect(bridge.assertQueueDurable()).rejects.toThrow(/could not be determined/);
  });

  it('REJECTS when CONFIG GET itself fails (ACL / renamed command)', async () => {
    const fake = makeFakeRedisClient();
    fake.config = vi.fn(() => Promise.reject(new Error('ERR unknown command')));
    const bridge = createRedisBridge(durableConfig(), { client: fake as unknown as Redis });
    await expect(bridge.assertQueueDurable()).rejects.toThrow(/could not be determined/);
  });

  it('downgrades to a warning when REDIS_REQUIRE_NOEVICTION=false, and still counts it', async () => {
    queueDurabilityViolationsTotal.reset();
    const fake = makeFakeRedisClient();
    fake.config = vi.fn(() => Promise.resolve(['maxmemory-policy', 'allkeys-lru']));
    const warn = vi.fn();
    const logger = { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const bridge = createRedisBridge(durableConfig({ REDIS_REQUIRE_NOEVICTION: false }), {
      client: fake as unknown as Redis,
      logger,
    });
    // This pinned toBeUndefined(): the value that let bootstrap follow this very warning
    // with 'queue durability asserted (maxmemory-policy=noeviction)'. A downgraded refusal
    // resolves as not durable, naming the policy.
    await expect(bridge.assertQueueDurable()).resolves.toEqual({
      durable: false,
      policy: 'allkeys-lru',
    });
    expect(warn).toHaveBeenCalledOnce();
    const body = await metricsRegister.metrics();
    expect(body).toMatch(
      /csms_bridge_queue_durability_violations_total\{[^}]*policy="allkeys-lru"[^}]*\} 1/,
    );
  });
});
