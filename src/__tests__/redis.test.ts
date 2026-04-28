import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import { __test__, createRedisBridge, ENVELOPE_VERSION } from '../redis.js';

const { parseOutgoingEnvelope, retryStrategy } = __test__;

// ── parseOutgoingEnvelope ──────────────────────────────────────────────────

const validEnvelope = {
  version: 1,
  topic: 'ospp/v1/stations/stn_00000001/to-station',
  payload: Buffer.from('hello').toString('base64'),
  qos: 1,
};

describe('parseOutgoingEnvelope — happy paths', () => {
  it('parses a valid envelope', () => {
    const env = parseOutgoingEnvelope(JSON.stringify(validEnvelope));
    expect(env.version).toBe(ENVELOPE_VERSION);
    expect(env.topic).toBe('ospp/v1/stations/stn_00000001/to-station');
    expect(env.payload).toBe(Buffer.from('hello').toString('base64'));
    expect(env.qos).toBe(1);
    expect(env.properties).toBeUndefined();
  });

  it('parses an envelope with optional properties', () => {
    const env = parseOutgoingEnvelope(
      JSON.stringify({
        ...validEnvelope,
        properties: { contentType: 'application/json', userProperties: { traceId: 'abc' } },
      }),
    );
    expect(env.properties).toEqual({
      contentType: 'application/json',
      userProperties: { traceId: 'abc' },
    });
  });

  it.each([0, 1, 2] as const)('accepts qos=%s', (qos) => {
    const env = parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, qos }));
    expect(env.qos).toBe(qos);
  });
});

describe('parseOutgoingEnvelope — version', () => {
  it('rejects envelope missing version field', () => {
    const { version: _omit, ...withoutVersion } = validEnvelope;
    expect(() => parseOutgoingEnvelope(JSON.stringify(withoutVersion))).toThrow(
      /missing "version" field/,
    );
  });

  it('rejects envelope with wrong version (2)', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, version: 2 }))).toThrow(
      /version mismatch.*got 2.*expected 1/,
    );
  });

  it('rejects envelope with string version', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, version: '1' }))).toThrow(
      /version mismatch.*got "1".*expected 1/,
    );
  });

  it('rejects envelope with null version', () => {
    expect(() =>
      parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, version: null })),
    ).toThrow(/version mismatch.*got null.*expected 1/);
  });
});

describe('parseOutgoingEnvelope — required fields', () => {
  it('rejects non-object root (string)', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify('a string'))).toThrow(/not an object/);
  });

  it('rejects null root', () => {
    expect(() => parseOutgoingEnvelope('null')).toThrow(/not an object/);
  });

  it('rejects empty topic', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, topic: '' }))).toThrow(
      /missing string "topic"/,
    );
  });

  it('rejects non-string topic', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, topic: 123 }))).toThrow(
      /missing string "topic"/,
    );
  });

  it('rejects non-string payload', () => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, payload: 123 }))).toThrow(
      /missing string "payload"/,
    );
  });

  it.each([3, -1, 1.5, 'high', null])('rejects invalid qos=%s', (qos) => {
    expect(() => parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, qos }))).toThrow(
      /qos.*must be 0, 1, or 2/,
    );
  });

  it('rejects non-object properties', () => {
    expect(() =>
      parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, properties: 'string' })),
    ).toThrow(/properties.*must be an object/);
  });

  it('rejects null properties (when present)', () => {
    expect(() =>
      parseOutgoingEnvelope(JSON.stringify({ ...validEnvelope, properties: null })),
    ).toThrow(/properties.*must be an object/);
  });
});

// ── retryStrategy ──────────────────────────────────────────────────────────

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
  blmove: ReturnType<typeof vi.fn>;
  lpush: ReturnType<typeof vi.fn>;
  lrem: ReturnType<typeof vi.fn>;
  lrange: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}

const makeFakeRedisClient = (): FakeRedis => ({
  status: 'wait',
  connect: vi.fn((): Promise<void> => Promise.resolve()),
  blmove: vi.fn(
    (
      _src: string,
      _dst: string,
      _srcDir: string,
      _dstDir: string,
      _timeout: number,
    ): Promise<string | null> => Promise.resolve(null),
  ),
  lpush: vi.fn((_key: string, _value: string): Promise<number> => Promise.resolve(1)),
  lrem: vi.fn(
    (_key: string, _count: number, _value: string): Promise<number> => Promise.resolve(1),
  ),
  lrange: vi.fn(
    (_key: string, _start: number, _stop: number): Promise<string[]> => Promise.resolve([]),
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

describe('createRedisBridge — popOutgoingReliable (BLMOVE)', () => {
  const validJson = JSON.stringify(validEnvelope);

  it('BLMOVEs from outgoing→processing with LEFT/RIGHT directions and configured timeout', async () => {
    const fake = makeFakeRedisClient();
    fake.blmove = vi.fn((): Promise<string | null> => Promise.resolve(validJson));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    const result = await bridge.popOutgoingReliable();

    expect(result).not.toBeNull();
    expect(fake.blmove).toHaveBeenCalledWith(
      'mqtt:outgoing',
      'mqtt:processing',
      'LEFT',
      'RIGHT',
      validConfig.REDIS_BLPOP_TIMEOUT_SEC,
    );
  });

  it('returns null on BLMOVE timeout (no message available)', async () => {
    const fake = makeFakeRedisClient();
    fake.blmove = vi.fn((): Promise<string | null> => Promise.resolve(null));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    const result = await bridge.popOutgoingReliable();
    expect(result).toBeNull();
  });

  it('returns parsed envelope and an ack() closure that LREMs the raw JSON', async () => {
    const fake = makeFakeRedisClient();
    fake.blmove = vi.fn((): Promise<string | null> => Promise.resolve(validJson));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    const result = await bridge.popOutgoingReliable();
    expect(result).not.toBeNull();
    expect(result?.envelope.topic).toBe(validEnvelope.topic);
    expect(result?.raw).toBe(validJson);

    await result?.ack();
    expect(fake.lrem).toHaveBeenCalledWith('mqtt:processing', 1, validJson);
  });

  it('drops malformed JSON from processing and re-throws', async () => {
    const fake = makeFakeRedisClient();
    const malformed = '{"version":1,"topic":"","payload":"x","qos":1}'; // empty topic
    fake.blmove = vi.fn((): Promise<string | null> => Promise.resolve(malformed));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    await expect(bridge.popOutgoingReliable()).rejects.toThrow(/missing string "topic"/);
    expect(fake.lrem).toHaveBeenCalledWith('mqtt:processing', 1, malformed);
  });

  it('drops malformed envelope with wrong version', async () => {
    const fake = makeFakeRedisClient();
    const wrongVersion = JSON.stringify({ ...validEnvelope, version: 99 });
    fake.blmove = vi.fn((): Promise<string | null> => Promise.resolve(wrongVersion));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    await expect(bridge.popOutgoingReliable()).rejects.toThrow(/version mismatch/);
    expect(fake.lrem).toHaveBeenCalledWith('mqtt:processing', 1, wrongVersion);
  });
});

describe('createRedisBridge — replayProcessing', () => {
  it('returns parsed items from the processing list', async () => {
    const fake = makeFakeRedisClient();
    const item1 = JSON.stringify(validEnvelope);
    const item2 = JSON.stringify({
      ...validEnvelope,
      topic: 'ospp/v1/stations/stn_00000002/to-station',
    });
    fake.lrange = vi.fn((): Promise<string[]> => Promise.resolve([item1, item2]));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    const items = await bridge.replayProcessing();
    expect(items).toHaveLength(2);
    expect(items[0]?.envelope.topic).toBe(validEnvelope.topic);
    expect(items[0]?.raw).toBe(item1);
    expect(items[1]?.envelope.topic).toBe('ospp/v1/stations/stn_00000002/to-station');

    expect(fake.lrange).toHaveBeenCalledWith('mqtt:processing', 0, -1);
  });

  it('returns empty array when processing queue is empty', async () => {
    const fake = makeFakeRedisClient();
    fake.lrange = vi.fn((): Promise<string[]> => Promise.resolve([]));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    const items = await bridge.replayProcessing();
    expect(items).toHaveLength(0);
  });

  it('drops malformed items from processing and continues with valid ones', async () => {
    const fake = makeFakeRedisClient();
    const valid = JSON.stringify(validEnvelope);
    const malformed = '{"not":"valid"}'; // missing version, topic, etc.
    fake.lrange = vi.fn((): Promise<string[]> => Promise.resolve([malformed, valid]));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    const items = await bridge.replayProcessing();
    expect(items).toHaveLength(1);
    expect(items[0]?.raw).toBe(valid);

    // The malformed item was LREM'd
    expect(fake.lrem).toHaveBeenCalledWith('mqtt:processing', 1, malformed);
  });

  it('returned ack() removes the item from processing', async () => {
    const fake = makeFakeRedisClient();
    const valid = JSON.stringify(validEnvelope);
    fake.lrange = vi.fn((): Promise<string[]> => Promise.resolve([valid]));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    const items = await bridge.replayProcessing();
    await items[0]?.ack();

    expect(fake.lrem).toHaveBeenCalledWith('mqtt:processing', 1, valid);
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
