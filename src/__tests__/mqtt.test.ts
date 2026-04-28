import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  IClientOptions,
  IClientPublishOptions,
  IClientSubscribeOptions,
  IConnackPacket,
  IPublishPacket,
  ISubscriptionGrant,
  MqttClient,
} from 'mqtt';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import type { MqttBridge, MqttConnector } from '../mqtt.js';
import {
  buildClientOptions,
  parseStationFromTopic,
  SERVER_STATUS_TOPIC,
  SHARED_SUB_TOPIC,
  startMqttClient,
} from '../mqtt.js';
import type { IncomingEnvelope, OutgoingEnvelope, RedisBridge } from '../redis.js';
import { resetState, state } from '../state.js';

// ── Test doubles ────────────────────────────────────────────────────────────

interface FakeMqttClient extends EventEmitter {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

const makeFakeClient = (): FakeMqttClient => {
  const ee = new EventEmitter() as FakeMqttClient;
  ee.subscribe = vi.fn(
    (
      topic: string,
      _opts: IClientSubscribeOptions,
      cb: (err: Error | null, granted: ISubscriptionGrant[]) => void,
    ) => {
      cb(null, [{ topic, qos: 1 }]);
      return ee as unknown as MqttClient;
    },
  );
  ee.unsubscribe = vi.fn((_topic: string, cb: (err?: Error | null) => void) => {
    cb(null);
    return ee as unknown as MqttClient;
  });
  ee.publish = vi.fn(
    (
      _topic: string,
      _payload: Buffer | string,
      _opts: IClientPublishOptions,
      cb?: (err?: Error) => void,
    ) => {
      cb?.();
      return ee as unknown as MqttClient;
    },
  );
  ee.end = vi.fn((_force?: boolean, _opts?: object, cb?: () => void) => {
    cb?.();
    return ee as unknown as MqttClient;
  });
  return ee;
};

interface FakeRedisBridge extends RedisBridge {
  pushed: IncomingEnvelope[];
  outgoing: OutgoingEnvelope[];
}

const makeFakeRedis = (queue: OutgoingEnvelope[] = []): FakeRedisBridge => {
  const pushed: IncomingEnvelope[] = [];
  const outgoing = [...queue];

  return {
    pushed,
    outgoing,
    pushIncoming: vi.fn((env: IncomingEnvelope): Promise<void> => {
      pushed.push(env);
      return Promise.resolve();
    }),
    popOutgoing: vi.fn(
      (): Promise<OutgoingEnvelope | null> =>
        new Promise((resolve) => {
          if (outgoing.length > 0) {
            resolve(outgoing.shift() ?? null);
            return;
          }
          // Simulate BLPOP timeout: yield control so the loop doesn't busy-spin
          // and stop() has a chance to flip the flag between iterations.
          setTimeout(() => {
            resolve(null);
          }, 1);
        }),
    ),
    quit: vi.fn((): Promise<void> => Promise.resolve()),
    isReady: vi.fn(() => true),
  };
};

// ── Fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string;
let validConfig: Config;
const silentLogger = pino({ level: 'silent' });
const activeBridges: MqttBridge[] = [];

/**
 * Wraps startMqttClient so the bridge is auto-tracked for afterEach cleanup.
 * Without it, the outbound loop keeps running and vitest's worker hangs.
 */
const start = (
  cfg: Config,
  redis: ReturnType<typeof makeFakeRedis>,
  connector: MqttConnector,
): MqttBridge => {
  const bridge = startMqttClient(cfg, redis, silentLogger, connector);
  activeBridges.push(bridge);
  return bridge;
};

const flushMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  resetState();

  tmpDir = join(
    tmpdir(),
    `csms-mqtt-test-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'cert.pem'), 'fake-cert');
  writeFileSync(join(tmpDir, 'key.pem'), 'fake-key');
  writeFileSync(join(tmpDir, 'ca.pem'), 'fake-ca');

  validConfig = loadConfig({
    MQTT_BROKER_URL: 'mqtts://broker.test:8884',
    MQTT_CLIENT_ID: 'csms-test-server-1',
    MQTT_CERT_PATH: join(tmpDir, 'cert.pem'),
    MQTT_KEY_PATH: join(tmpDir, 'key.pem'),
    MQTT_CA_PATH: join(tmpDir, 'ca.pem'),
    REDIS_URL: 'redis://redis.test:6379',
  });
});

afterEach(async () => {
  // Stop every bridge created in this test so the outbound loop terminates and
  // vitest's worker can exit cleanly.
  while (activeBridges.length > 0) {
    const b = activeBridges.pop();
    if (b) await b.stop();
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── parseStationFromTopic ───────────────────────────────────────────────────

describe('parseStationFromTopic', () => {
  it.each([
    // 8-char numeric (all 0-9, valid hex)
    ['ospp/v1/stations/stn_00000001/to-server', 'stn_00000001'],
    // 8-char mixed hex
    ['ospp/v1/stations/stn_a1b2c3d4/to-server', 'stn_a1b2c3d4'],
    // 12-char hex
    ['ospp/v1/stations/stn_a1b2c3d4e5f6/to-server', 'stn_a1b2c3d4e5f6'],
    // 60-char hex (upper bound)
    [
      'ospp/v1/stations/stn_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6/to-server',
      'stn_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
    ],
  ])('extracts stationId from %s', (topic, expected) => {
    expect(parseStationFromTopic(topic)).toBe(expected);
  });

  it.each([
    'ospp/v1/stations/stn_/to-server', // empty body
    'ospp/v1/stations/STN_00000001/to-server', // uppercase prefix
    'ospp/v1/stations/abc/to-server', // missing stn_ prefix
    'ospp/v1/stations/stn_00000001/to-station', // wrong direction
    'ospp/v2/stations/stn_00000001/to-server', // wrong major version
    'ospp/v1/stations/stn_00000001/to-server/extra', // trailing segment
    'random/topic',
    '',
    // Spec compliance — added when regex tightened to ^stn_[a-f0-9]{8,60}$:
    'ospp/v1/stations/stn_invalidchars/to-server', // non-hex chars (i, n, v, l, h, r, s)
    'ospp/v1/stations/stn_short/to-server', // under 8 chars
    'ospp/v1/stations/stn_abc/to-server', // 3 chars — formerly accepted, now under-min
    'ospp/v1/stations/stn_ABC12345/to-server', // uppercase hex (regex is lowercase only)
    'ospp/v1/stations/stn_a1b2c3d/to-server', // exactly 7 chars — under-min by 1
    // 61 hex chars — over upper bound by 1
    'ospp/v1/stations/stn_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a/to-server',
    // Original prompt's over-60 case (66 hex chars)
    'ospp/v1/stations/stn_a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890/to-server',
  ])('rejects topic: %s', (topic) => {
    expect(parseStationFromTopic(topic)).toBeNull();
  });
});

// ── buildClientOptions ──────────────────────────────────────────────────────

describe('buildClientOptions', () => {
  it('produces MQTT 5 mTLS options with persistent session and LWT', () => {
    const opts: IClientOptions = buildClientOptions(validConfig);

    expect(opts.clientId).toBe('csms-test-server-1');
    expect(opts.protocolVersion).toBe(5);
    expect(opts.clean).toBe(false);
    expect(opts.keepalive).toBe(60);
    expect(opts.reconnectPeriod).toBe(5000);
    expect(opts.connectTimeout).toBe(30_000);
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.resubscribe).toBe(false);

    expect(Buffer.isBuffer(opts.cert)).toBe(true);
    expect(Buffer.isBuffer(opts.key)).toBe(true);
    expect(Buffer.isBuffer(opts.ca)).toBe(true);
    expect((opts.cert as Buffer).toString()).toBe('fake-cert');
    expect((opts.key as Buffer).toString()).toBe('fake-key');
    expect((opts.ca as Buffer).toString()).toBe('fake-ca');

    expect(opts.will?.topic).toBe(SERVER_STATUS_TOPIC);
    expect(opts.will?.qos).toBe(1);
    expect(opts.will?.retain).toBe(true);
    expect(opts.will?.payload).toBeDefined();
    const willPayload = JSON.parse(opts.will?.payload.toString() ?? '') as Record<string, unknown>;
    expect(willPayload['clientId']).toBe('csms-test-server-1');
    expect(willPayload['status']).toBe('offline');
    expect(typeof willPayload['ts']).toBe('number');
  });

  it('reflects MQTT_REJECT_UNAUTHORIZED=false in options', () => {
    const cfg = loadConfig({
      MQTT_BROKER_URL: 'mqtts://broker.test:8884',
      MQTT_CLIENT_ID: 'csms-test-server-1',
      MQTT_CERT_PATH: join(tmpDir, 'cert.pem'),
      MQTT_KEY_PATH: join(tmpDir, 'key.pem'),
      MQTT_CA_PATH: join(tmpDir, 'ca.pem'),
      REDIS_URL: 'redis://redis.test:6379',
      MQTT_REJECT_UNAUTHORIZED: 'false',
    });
    const opts = buildClientOptions(cfg);
    expect(opts.rejectUnauthorized).toBe(false);
  });
});

// ── startMqttClient ─────────────────────────────────────────────────────────

describe('startMqttClient', () => {
  const fireConnect = (client: FakeMqttClient): void => {
    const packet: IConnackPacket = {
      cmd: 'connack',
      sessionPresent: false,
      reasonCode: 0,
      returnCode: 0,
    };
    client.emit('connect', packet);
  };

  it('uses the provided connector with correct broker URL and options', () => {
    const fakeClient = makeFakeClient();
    const connector = vi.fn(
      (_url: string, _opts: IClientOptions) => fakeClient as unknown as MqttClient,
    );

    start(validConfig, makeFakeRedis(), connector);

    expect(connector).toHaveBeenCalledTimes(1);
    expect(connector.mock.calls[0]?.[0]).toBe('mqtts://broker.test:8884');
    const opts = connector.mock.calls[0]?.[1];
    expect(opts?.clientId).toBe('csms-test-server-1');
    expect(opts?.protocolVersion).toBe(5);
  });

  it('subscribes to the shared topic on connect', async () => {
    const fakeClient = makeFakeClient();
    const connector = vi.fn(
      (_url: string, _opts: IClientOptions) => fakeClient as unknown as MqttClient,
    );

    start(validConfig, makeFakeRedis(), connector);
    fireConnect(fakeClient);
    await flushMicrotasks();

    expect(fakeClient.subscribe).toHaveBeenCalledTimes(1);
    expect(fakeClient.subscribe.mock.calls[0]?.[0]).toBe(SHARED_SUB_TOPIC);
    expect(fakeClient.subscribe.mock.calls[0]?.[1]).toEqual({ qos: 1 });
  });

  it('publishes online status on connect', () => {
    const fakeClient = makeFakeClient();
    const connector = vi.fn(
      (_url: string, _opts: IClientOptions) => fakeClient as unknown as MqttClient,
    );

    start(validConfig, makeFakeRedis(), connector);
    fireConnect(fakeClient);

    const publishCalls = fakeClient.publish.mock.calls;
    const statusCall = publishCalls.find((c) => c[0] === SERVER_STATUS_TOPIC);
    expect(statusCall).toBeDefined();
    const payload = statusCall?.[1] as Buffer;
    const opts = statusCall?.[2] as IClientPublishOptions;
    expect(payload.toString()).toContain('"status":"online"');
    expect(opts).toMatchObject({ qos: 1, retain: true });
  });

  it('flips state.mqttConnected on connect/close/offline', () => {
    const fakeClient = makeFakeClient();
    const connector = vi.fn(
      (_url: string, _opts: IClientOptions) => fakeClient as unknown as MqttClient,
    );

    start(validConfig, makeFakeRedis(), connector);
    expect(state.mqttConnected).toBe(false);

    fireConnect(fakeClient);
    expect(state.mqttConnected).toBe(true);

    fakeClient.emit('close');
    expect(state.mqttConnected).toBe(false);

    fireConnect(fakeClient);
    expect(state.mqttConnected).toBe(true);

    fakeClient.emit('offline');
    expect(state.mqttConnected).toBe(false);
  });

  it('increments reconnectCount on each reconnect event', () => {
    const fakeClient = makeFakeClient();
    const connector = vi.fn(
      (_url: string, _opts: IClientOptions) => fakeClient as unknown as MqttClient,
    );

    start(validConfig, makeFakeRedis(), connector);
    fakeClient.emit('reconnect');
    fakeClient.emit('reconnect');
    fakeClient.emit('reconnect');

    expect(state.reconnectCount).toBe(3);
  });
});

// ── Inbound handling ────────────────────────────────────────────────────────

describe('startMqttClient — inbound', () => {
  const emitMessage = (
    client: FakeMqttClient,
    topic: string,
    payloadBytes: Buffer,
    qos: 0 | 1 | 2 = 1,
  ): void => {
    const packet: IPublishPacket = {
      cmd: 'publish',
      qos,
      dup: false,
      retain: false,
      topic,
      payload: payloadBytes,
      properties: { contentType: 'application/json' },
    };
    client.emit('message', topic, payloadBytes, packet);
  };

  it('pushes a structured envelope to redis on a valid topic', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();
    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    const payloadBytes = Buffer.from('{"hello":"world"}');
    emitMessage(fakeClient, 'ospp/v1/stations/stn_00000001/to-server', payloadBytes);
    await flushMicrotasks();

    expect(fakeRedis.pushed).toHaveLength(1);
    const env = fakeRedis.pushed[0];
    expect(env).toBeDefined();
    expect(env?.topic).toBe('ospp/v1/stations/stn_00000001/to-server');
    expect(env?.stationId).toBe('stn_00000001');
    expect(env?.qos).toBe(1);
    expect(Buffer.from(env?.payload ?? '', 'base64').toString()).toBe('{"hello":"world"}');
    expect(env?.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof env?.receivedAt).toBe('string');
    expect(env?.properties).toEqual({ contentType: 'application/json' });

    expect(state.lastMessageReceivedAt).toBeInstanceOf(Date);
  });

  it('drops messages on unexpected topics without pushing', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();
    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    emitMessage(fakeClient, 'ospp/v1/stations/INVALID/to-server', Buffer.from('x'));
    emitMessage(fakeClient, 'random/topic', Buffer.from('y'));
    await flushMicrotasks();

    expect(fakeRedis.pushed).toHaveLength(0);
  });

  it('does not crash when redis push throws', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();
    fakeRedis.pushIncoming = vi.fn((): Promise<void> => Promise.reject(new Error('redis down')));

    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    emitMessage(fakeClient, 'ospp/v1/stations/stn_00000001/to-server', Buffer.from('x'));
    await flushMicrotasks();
    // Test passes if no unhandled rejection / crash.
  });
});

// ── Outbound loop ───────────────────────────────────────────────────────────

describe('startMqttClient — outbound loop', () => {
  it('publishes envelopes pulled from redis with base64-decoded payload', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis([
      {
        topic: 'ospp/v1/stations/stn_00000001/to-station',
        payload: Buffer.from('{"action":"BootNotificationResponse"}').toString('base64'),
        qos: 1,
      },
    ]);

    const bridge = start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    // Allow the outbound loop to pop and publish.
    for (let i = 0; i < 5 && fakeRedis.outgoing.length > 0; i++) {
      await flushMicrotasks();
    }
    // One more tick for the publish callback.
    await flushMicrotasks();

    const publishCalls = fakeClient.publish.mock.calls.filter(
      (c) => c[0] === 'ospp/v1/stations/stn_00000001/to-station',
    );
    expect(publishCalls).toHaveLength(1);
    const payload = publishCalls[0]?.[1] as Buffer;
    const opts = publishCalls[0]?.[2] as IClientPublishOptions;
    expect(Buffer.isBuffer(payload)).toBe(true);
    expect(payload.toString()).toBe('{"action":"BootNotificationResponse"}');
    expect(opts).toMatchObject({ qos: 1 });

    await bridge.stop();
  });

  it('survives a malformed envelope and continues processing', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();
    let popsRemaining = 1;
    fakeRedis.popOutgoing = vi.fn((): Promise<OutgoingEnvelope | null> => {
      if (popsRemaining-- > 0) {
        return Promise.reject(new Error('malformed envelope: oops'));
      }
      return Promise.resolve(null);
    });

    const bridge = start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    // Wait long enough for the loop to error once and back off.
    await new Promise((r) => setTimeout(r, 50));
    await bridge.stop();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mocks have no `this` binding
    expect(fakeRedis.popOutgoing).toHaveBeenCalled();
    // Bridge stopped without throwing — good.
  });
});

// ── Stop semantics ──────────────────────────────────────────────────────────

describe('startMqttClient — stop()', () => {
  it('unsubscribes, publishes offline, and ends the client', async () => {
    const fakeClient = makeFakeClient();
    const bridge = start(validConfig, makeFakeRedis(), () => fakeClient as unknown as MqttClient);

    // Force connected state so stop() runs the unsubscribe + offline path.
    state.mqttConnected = true;

    await bridge.stop();

    expect(fakeClient.unsubscribe).toHaveBeenCalledWith(SHARED_SUB_TOPIC, expect.any(Function));

    const offlineCall = fakeClient.publish.mock.calls.find((c) => {
      if (c[0] !== SERVER_STATUS_TOPIC) return false;
      const payload = c[1] as Buffer;
      return payload.toString().includes('"status":"offline"');
    });
    expect(offlineCall).toBeDefined();
    expect(offlineCall?.[2]).toMatchObject({ qos: 1, retain: true });

    expect(fakeClient.end).toHaveBeenCalledTimes(1);
    expect(fakeClient.end.mock.calls[0]?.[0]).toBe(false);
  });

  it('skips MQTT-side cleanup when never connected', async () => {
    const fakeClient = makeFakeClient();
    const bridge = start(validConfig, makeFakeRedis(), () => fakeClient as unknown as MqttClient);

    // state.mqttConnected stays false.
    await bridge.stop();

    expect(fakeClient.unsubscribe).not.toHaveBeenCalled();
    // No status publish either (no connection → can't publish).
    const statusPublishes = fakeClient.publish.mock.calls.filter(
      (c) => c[0] === SERVER_STATUS_TOPIC,
    );
    expect(statusPublishes).toHaveLength(0);
    expect(fakeClient.end).toHaveBeenCalledTimes(1);
  });
});
