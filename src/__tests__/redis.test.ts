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

// ── Separate blocking client (BLMOVE HOL-blocking fix) ─────────────────────
//
// With a single ioredis connection, the 5s blocking BLMOVE serialized any
// concurrent LPUSH (inbound MQTT) behind it, gating PUBACK and causing
// broker re-delivery. createRedisBridge now uses a dedicated `blockingClient`
// (via client.duplicate() in production) so non-blocking ops never wait
// behind an active BLMOVE.
describe('createRedisBridge — separate blocking client', () => {
  it('routes BLMOVE to blockingClient, not the main client', async () => {
    const fakeMain = makeFakeRedisClient();
    const fakeBlocking = makeFakeRedisClient();
    fakeBlocking.blmove = vi.fn((): Promise<string | null> => Promise.resolve(null));
    const bridge = createRedisBridge(validConfig, {
      client: fakeMain as unknown as Redis,
      blockingClient: fakeBlocking as unknown as Redis,
    });

    await bridge.popOutgoingReliable();

    expect(fakeBlocking.blmove).toHaveBeenCalledTimes(1);
    expect(fakeMain.blmove).not.toHaveBeenCalled();
  });

  it('routes LPUSH (pushIncoming) to the main client, not blockingClient', async () => {
    const fakeMain = makeFakeRedisClient();
    const fakeBlocking = makeFakeRedisClient();
    const bridge = createRedisBridge(validConfig, {
      client: fakeMain as unknown as Redis,
      blockingClient: fakeBlocking as unknown as Redis,
    });

    await bridge.pushIncoming({
      version: 1,
      topic: 'ospp/v1/stations/stn_00000001/to-server',
      stationId: 'stn_00000001',
      payload: 'aGVsbG8=',
      qos: 1,
      receivedAt: '2026-05-16T00:00:00.000Z',
      messageId: '00000000-0000-0000-0000-000000000001',
      properties: null,
    });

    expect(fakeMain.lpush).toHaveBeenCalledTimes(1);
    expect(fakeBlocking.lpush).not.toHaveBeenCalled();
  });

  it('LPUSH resolves while BLMOVE is still pending (no head-of-line blocking)', async () => {
    const fakeMain = makeFakeRedisClient();
    const fakeBlocking = makeFakeRedisClient();

    // Pending blmove — only resolves when we say so. Mirrors a real 5s blocking
    // pop sitting in the kernel TCP buffer.
    let resolveBlmove: ((value: string | null) => void) | undefined;
    fakeBlocking.blmove = vi.fn(
      (): Promise<string | null> =>
        new Promise<string | null>((res) => {
          resolveBlmove = res;
        }),
    );

    const bridge = createRedisBridge(validConfig, {
      client: fakeMain as unknown as Redis,
      blockingClient: fakeBlocking as unknown as Redis,
    });

    // Start the pop — it pends indefinitely on fakeBlocking.blmove.
    const popP = bridge.popOutgoingReliable();
    // Yield so the pop's microtask actually starts before we time pushIncoming.
    await Promise.resolve();

    const t0 = Date.now();
    await bridge.pushIncoming({
      version: 1,
      topic: 'ospp/v1/stations/stn_00000001/to-server',
      stationId: 'stn_00000001',
      payload: 'aGVsbG8=',
      qos: 1,
      receivedAt: '2026-05-16T00:00:00.000Z',
      messageId: '00000000-0000-0000-0000-000000000002',
      properties: null,
    });
    const elapsed = Date.now() - t0;

    // LPUSH on the main fake is a vi.fn that resolves synchronously; if the
    // two-client architecture regressed to a single client, the pending blmove
    // would not block this since fakes don't model TCP-level HOL — but this
    // also asserts the structural invariant that pushIncoming did NOT await
    // anything on the blocking client.
    expect(elapsed).toBeLessThan(50);
    expect(fakeMain.lpush).toHaveBeenCalledTimes(1);
    expect(fakeBlocking.blmove).toHaveBeenCalledTimes(1);

    // Cleanup so the pending pop promise resolves.
    resolveBlmove?.(null);
    await popP;
  });

  it('start() connects both clients concurrently', async () => {
    const fakeMain = makeFakeRedisClient();
    const fakeBlocking = makeFakeRedisClient();
    fakeMain.status = 'wait';
    fakeBlocking.status = 'wait';
    const bridge = createRedisBridge(validConfig, {
      client: fakeMain as unknown as Redis,
      blockingClient: fakeBlocking as unknown as Redis,
    });

    await bridge.start();

    expect(fakeMain.connect).toHaveBeenCalledTimes(1);
    expect(fakeBlocking.connect).toHaveBeenCalledTimes(1);
  });

  it('start() skips connect on whichever client is already ready', async () => {
    const fakeMain = makeFakeRedisClient();
    const fakeBlocking = makeFakeRedisClient();
    fakeMain.status = 'ready';
    fakeBlocking.status = 'wait';
    const bridge = createRedisBridge(validConfig, {
      client: fakeMain as unknown as Redis,
      blockingClient: fakeBlocking as unknown as Redis,
    });

    await bridge.start();

    expect(fakeMain.connect).not.toHaveBeenCalled();
    expect(fakeBlocking.connect).toHaveBeenCalledTimes(1);
  });

  it('quit() quits both clients', async () => {
    const fakeMain = makeFakeRedisClient();
    const fakeBlocking = makeFakeRedisClient();
    const bridge = createRedisBridge(validConfig, {
      client: fakeMain as unknown as Redis,
      blockingClient: fakeBlocking as unknown as Redis,
    });

    await bridge.quit();

    expect(fakeMain.quit).toHaveBeenCalledTimes(1);
    expect(fakeBlocking.quit).toHaveBeenCalledTimes(1);
  });

  it('quit() tolerates either client rejecting', async () => {
    const fakeMain = makeFakeRedisClient();
    const fakeBlocking = makeFakeRedisClient();
    fakeBlocking.quit = vi.fn(
      (): Promise<'OK'> => Promise.reject(new Error('blocking already closed')),
    );
    const bridge = createRedisBridge(validConfig, {
      client: fakeMain as unknown as Redis,
      blockingClient: fakeBlocking as unknown as Redis,
    });

    await expect(bridge.quit()).resolves.toBeUndefined();
    expect(fakeMain.quit).toHaveBeenCalledTimes(1);
  });

  it('isReady() requires BOTH clients to be ready', () => {
    const fakeMain = makeFakeRedisClient();
    const fakeBlocking = makeFakeRedisClient();
    const bridge = createRedisBridge(validConfig, {
      client: fakeMain as unknown as Redis,
      blockingClient: fakeBlocking as unknown as Redis,
    });

    fakeMain.status = 'ready';
    fakeBlocking.status = 'wait';
    expect(bridge.isReady()).toBe(false);

    fakeMain.status = 'wait';
    fakeBlocking.status = 'ready';
    expect(bridge.isReady()).toBe(false);

    fakeMain.status = 'ready';
    fakeBlocking.status = 'ready';
    expect(bridge.isReady()).toBe(true);
  });

  it('falls back to the single injected client when blockingClient is omitted (backward-compat)', async () => {
    const fake = makeFakeRedisClient();
    fake.blmove = vi.fn((): Promise<string | null> => Promise.resolve(null));
    const bridge = createRedisBridge(validConfig, { client: fake as unknown as Redis });

    // BLMOVE and LPUSH both land on the single injected fake — preserves the
    // pre-fix injection surface used by all existing tests.
    await bridge.popOutgoingReliable();
    await bridge.pushIncoming({
      version: 1,
      topic: 'ospp/v1/stations/stn_00000001/to-server',
      stationId: 'stn_00000001',
      payload: 'aGVsbG8=',
      qos: 1,
      receivedAt: '2026-05-16T00:00:00.000Z',
      messageId: '00000000-0000-0000-0000-000000000003',
      properties: null,
    });

    expect(fake.blmove).toHaveBeenCalledTimes(1);
    expect(fake.lpush).toHaveBeenCalledTimes(1);
    // quit() should only quit once, since both refs point to the same fake.
    await bridge.quit();
    expect(fake.quit).toHaveBeenCalledTimes(1);
  });
});
