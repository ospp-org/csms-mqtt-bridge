import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  DoneCallback,
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
  serverStatusTopicFor,
  SHARED_SUB_TOPIC,
  startMqttClient,
} from '../mqtt.js';
import type {
  IncomingEnvelope,
  OutgoingEnvelope,
  RedisBridge,
  ReliableOutgoing,
} from '../redis.js';
import { resetState, state } from '../state.js';

// ── Test doubles ────────────────────────────────────────────────────────────

interface FakeMqttClient extends EventEmitter {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  handleMessage?: (packet: IPublishPacket, callback: DoneCallback) => void;
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
  /** Raw JSON strings of envelopes whose ack() callback was invoked. */
  acked: string[];
}

interface MakeFakeRedisOpts {
  outgoing?: OutgoingEnvelope[];
  /** Items pre-loaded into the processing queue (returned by replayProcessing). */
  processing?: OutgoingEnvelope[];
}

const makeFakeRedis = (opts: MakeFakeRedisOpts = {}): FakeRedisBridge => {
  const pushed: IncomingEnvelope[] = [];
  const outgoing = [...(opts.outgoing ?? [])];
  const processing = [...(opts.processing ?? [])];
  const acked: string[] = [];

  const ackOf = (raw: string) => (): Promise<void> => {
    acked.push(raw);
    return Promise.resolve();
  };

  return {
    pushed,
    outgoing,
    acked,

    start: vi.fn((): Promise<void> => Promise.resolve()),

    pushIncoming: vi.fn((env: IncomingEnvelope): Promise<void> => {
      pushed.push(env);
      return Promise.resolve();
    }),

    popOutgoingReliable: vi.fn(
      (): Promise<ReliableOutgoing | null> =>
        new Promise((resolve) => {
          if (outgoing.length > 0) {
            const env = outgoing.shift();
            if (env) {
              const raw = JSON.stringify(env);
              resolve({ envelope: env, raw, ack: ackOf(raw) });
              return;
            }
          }
          // Simulate BLMOVE timeout: yield so the loop doesn't busy-spin
          // and stop() can flip the flag between iterations.
          setTimeout(() => {
            resolve(null);
          }, 1);
        }),
    ),

    replayProcessing: vi.fn((): Promise<ReliableOutgoing[]> => {
      const items: ReliableOutgoing[] = processing.map((env) => {
        const raw = JSON.stringify(env);
        return { envelope: env, raw, ack: ackOf(raw) };
      });
      return Promise.resolve(items);
    }),

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

const wait = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

const makePacket = (topic: string, payload: Buffer, qos: 0 | 1 | 2 = 1): IPublishPacket => ({
  cmd: 'publish',
  qos,
  dup: false,
  retain: false,
  topic,
  payload,
  properties: { contentType: 'application/json' },
});

/** Calls client.handleMessage (installed by startMqttClient) and resolves with err|undefined. */
const callHandleMessage = (
  client: FakeMqttClient,
  packet: IPublishPacket,
): Promise<Error | undefined> => {
  if (!client.handleMessage) throw new Error('handleMessage not installed');
  return new Promise((resolve) => {
    client.handleMessage?.(packet, (err) => {
      resolve(err);
    });
  });
};

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

    expect(opts.will?.topic).toBe('ospp/v1/servers/csms-test-server-1/status');
    expect(opts.will?.topic).toBe(serverStatusTopicFor('csms-test-server-1'));
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

  it('omits `servername` when MQTT_SERVERNAME is unset', () => {
    const opts = buildClientOptions(validConfig);
    expect('servername' in opts).toBe(false);
  });

  it('omits `ca` when MQTT_CA_PATH is unset (Node default trust)', () => {
    const cfg = loadConfig({
      MQTT_BROKER_URL: 'mqtts://broker.test:8884',
      MQTT_CLIENT_ID: 'csms-test-server-1',
      MQTT_CERT_PATH: join(tmpDir, 'cert.pem'),
      MQTT_KEY_PATH: join(tmpDir, 'key.pem'),
      REDIS_URL: 'redis://redis.test:6379',
    });
    const opts = buildClientOptions(cfg);
    expect('ca' in opts).toBe(false);
  });

  it('reads CA bundle into `ca` buffer when MQTT_CA_PATH is set', () => {
    const opts = buildClientOptions(validConfig);
    expect(Buffer.isBuffer(opts.ca)).toBe(true);
    expect((opts.ca as Buffer).toString()).toBe('fake-ca');
  });

  it('forwards MQTT_SERVERNAME as `servername` for SNI', () => {
    const cfg = loadConfig({
      MQTT_BROKER_URL: 'mqtts://emqx:8883',
      MQTT_CLIENT_ID: 'csms-test-server-1',
      MQTT_CERT_PATH: join(tmpDir, 'cert.pem'),
      MQTT_KEY_PATH: join(tmpDir, 'key.pem'),
      MQTT_CA_PATH: join(tmpDir, 'ca.pem'),
      REDIS_URL: 'redis://redis.test:6379',
      MQTT_SERVERNAME: 'mqtt-uat.onestoppay.ro',
    });
    const opts = buildClientOptions(cfg);
    expect(opts.servername).toBe('mqtt-uat.onestoppay.ro');
  });
});

// ── startMqttClient — connect / subscribe / status ──────────────────────────

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

  it('installs handleMessage override on the client', () => {
    const fakeClient = makeFakeClient();
    expect(fakeClient.handleMessage).toBeUndefined();
    start(validConfig, makeFakeRedis(), () => fakeClient as unknown as MqttClient);
    expect(fakeClient.handleMessage).toBeDefined();
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

    const expectedStatusTopic = serverStatusTopicFor('csms-test-server-1');
    const publishCalls = fakeClient.publish.mock.calls;
    const statusCall = publishCalls.find((c) => c[0] === expectedStatusTopic);
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

// ── Inbound — handleMessage manual ack ──────────────────────────────────────

describe('startMqttClient — inbound (handleMessage manual ack)', () => {
  it('pushes envelope to redis AND acks (callback() with no error) on valid topic', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();
    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    const payloadBytes = Buffer.from('{"hello":"world"}');
    const result = await callHandleMessage(
      fakeClient,
      makePacket('ospp/v1/stations/stn_00000001/to-server', payloadBytes),
    );

    expect(result).toBeUndefined(); // ack
    expect(fakeRedis.pushed).toHaveLength(1);
    const env = fakeRedis.pushed[0];
    expect(env?.version).toBe(1);
    expect(env?.topic).toBe('ospp/v1/stations/stn_00000001/to-server');
    expect(env?.stationId).toBe('stn_00000001');
    expect(env?.qos).toBe(1);
    expect(Buffer.from(env?.payload ?? '', 'base64').toString()).toBe('{"hello":"world"}');
    expect(env?.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof env?.receivedAt).toBe('string');
    expect(env?.properties).toEqual({ contentType: 'application/json' });

    expect(state.lastMessageReceivedAt).toBeInstanceOf(Date);
  });

  it('does NOT ack (callback called with Error) when redis push fails', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();
    fakeRedis.pushIncoming = vi.fn((): Promise<void> => Promise.reject(new Error('redis down')));
    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    const result = await callHandleMessage(
      fakeClient,
      makePacket('ospp/v1/stations/stn_00000001/to-server', Buffer.from('x')),
    );

    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toBe('redis down');
  });

  it('acks (callback() with no error) on invalid topic — drops garbage', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();
    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    const result = await callHandleMessage(
      fakeClient,
      makePacket('random/garbage/topic', Buffer.from('x')),
    );

    expect(result).toBeUndefined(); // ack-and-drop
    expect(fakeRedis.pushed).toHaveLength(0);
  });

  it('handles payload as string (rare mqtt.js path)', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();
    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    // mqtt.js IPublishPacket.payload is `Buffer | string`; this exercises the
    // string branch in handleInbound.
    const packet: IPublishPacket = {
      ...makePacket('ospp/v1/stations/stn_00000001/to-server', Buffer.from('')),
      payload: 'hello-string',
    };
    const result = await callHandleMessage(fakeClient, packet);

    expect(result).toBeUndefined();
    expect(fakeRedis.pushed).toHaveLength(1);
    expect(Buffer.from(fakeRedis.pushed[0]?.payload ?? '', 'base64').toString()).toBe(
      'hello-string',
    );
  });
});

// ── Outbound loop — popOutgoingReliable + ack ───────────────────────────────

describe('startMqttClient — outbound loop (BLMOVE + ack)', () => {
  it('publishes envelope from outgoing and calls ack() after PUBACK', async () => {
    const fakeClient = makeFakeClient();
    const env: OutgoingEnvelope = {
      version: 1,
      topic: 'ospp/v1/stations/stn_00000001/to-station',
      payload: Buffer.from('{"action":"BootNotificationResponse"}').toString('base64'),
      qos: 1,
    };
    const fakeRedis = makeFakeRedis({ outgoing: [env] });

    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    // Wait for the loop to pop, publish, ack
    for (let i = 0; i < 20 && fakeRedis.acked.length === 0; i++) {
      await wait(5);
    }

    expect(fakeRedis.acked).toHaveLength(1);
    expect(fakeRedis.acked[0]).toBe(JSON.stringify(env));

    const publishCalls = fakeClient.publish.mock.calls.filter(
      (c) => c[0] === 'ospp/v1/stations/stn_00000001/to-station',
    );
    expect(publishCalls).toHaveLength(1);
    const payload = publishCalls[0]?.[1] as Buffer;
    expect(payload.toString()).toBe('{"action":"BootNotificationResponse"}');
  });

  it('does NOT ack when MQTT publish fails — envelope stays for retry', async () => {
    const fakeClient = makeFakeClient();
    fakeClient.publish = vi.fn(
      (
        _topic: string,
        _payload: Buffer | string,
        _opts: IClientPublishOptions,
        cb?: (err?: Error) => void,
      ) => {
        cb?.(new Error('broker disconnected'));
        return fakeClient as unknown as MqttClient;
      },
    );
    const env: OutgoingEnvelope = {
      version: 1,
      topic: 'ospp/v1/stations/stn_00000001/to-station',
      payload: Buffer.from('x').toString('base64'),
      qos: 1,
    };
    const fakeRedis = makeFakeRedis({ outgoing: [env] });

    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    // Wait long enough for one publish attempt + the 1s backoff to start
    await wait(50);

    expect(fakeClient.publish).toHaveBeenCalled();
    expect(fakeRedis.acked).toHaveLength(0); // NOT acked
  });

  it('continues after a malformed envelope (popOutgoingReliable throws)', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();
    let callCount = 0;
    fakeRedis.popOutgoingReliable = vi.fn((): Promise<ReliableOutgoing | null> => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('malformed envelope: oops'));
      }
      return Promise.resolve(null);
    });

    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);
    await wait(50);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mocks have no `this` binding
    expect(fakeRedis.popOutgoingReliable).toHaveBeenCalled();
    // Test passes if the bridge didn't crash (no unhandled rejection)
  });
});

// ── Replay processing on first connect ──────────────────────────────────────

describe('startMqttClient — replay processing on first connect', () => {
  const fireConnect = (client: FakeMqttClient): void => {
    const packet: IConnackPacket = {
      cmd: 'connack',
      sessionPresent: false,
      reasonCode: 0,
      returnCode: 0,
    };
    client.emit('connect', packet);
  };

  it('replays processing queue items and acks them when publish succeeds', async () => {
    const fakeClient = makeFakeClient();
    const stuck: OutgoingEnvelope = {
      version: 1,
      topic: 'ospp/v1/stations/stn_00000001/to-station',
      payload: Buffer.from('replay-payload').toString('base64'),
      qos: 1,
    };
    const fakeRedis = makeFakeRedis({ processing: [stuck] });

    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);
    fireConnect(fakeClient);

    // Wait for async replay chain
    for (let i = 0; i < 20 && fakeRedis.acked.length === 0; i++) {
      await wait(5);
    }

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mocks have no `this` binding
    expect(fakeRedis.replayProcessing).toHaveBeenCalledTimes(1);
    expect(fakeRedis.acked).toHaveLength(1);

    const publishCalls = fakeClient.publish.mock.calls.filter(
      (c) => c[0] === 'ospp/v1/stations/stn_00000001/to-station',
    );
    expect(publishCalls).toHaveLength(1);
  });

  it('only triggers replay once across multiple connect events', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();

    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    fireConnect(fakeClient);
    await flushMicrotasks();
    fakeClient.emit('close');
    fireConnect(fakeClient);
    await flushMicrotasks();
    fakeClient.emit('close');
    fireConnect(fakeClient);
    await flushMicrotasks();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mocks have no `this` binding
    expect(fakeRedis.replayProcessing).toHaveBeenCalledTimes(1);
  });

  it('does nothing visible when processing queue is empty', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();

    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);
    fireConnect(fakeClient);
    await flushMicrotasks();
    await flushMicrotasks();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mocks have no `this` binding
    expect(fakeRedis.replayProcessing).toHaveBeenCalledTimes(1);
    expect(fakeRedis.acked).toHaveLength(0);
  });

  it('replay does NOT ack when publish fails — item stays for next attempt', async () => {
    const fakeClient = makeFakeClient();
    fakeClient.publish = vi.fn(
      (
        _topic: string,
        _payload: Buffer | string,
        _opts: IClientPublishOptions,
        cb?: (err?: Error) => void,
      ) => {
        cb?.(new Error('broker not ready'));
        return fakeClient as unknown as MqttClient;
      },
    );
    const stuck: OutgoingEnvelope = {
      version: 1,
      topic: 'ospp/v1/stations/stn_00000001/to-station',
      payload: Buffer.from('x').toString('base64'),
      qos: 1,
    };
    const fakeRedis = makeFakeRedis({ processing: [stuck] });

    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);
    fireConnect(fakeClient);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(fakeRedis.acked).toHaveLength(0);
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

    const expectedStatusTopic = serverStatusTopicFor('csms-test-server-1');
    const offlineCall = fakeClient.publish.mock.calls.find((c) => {
      if (c[0] !== expectedStatusTopic) return false;
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
    const expectedStatusTopic = serverStatusTopicFor('csms-test-server-1');
    const statusPublishes = fakeClient.publish.mock.calls.filter(
      (c) => c[0] === expectedStatusTopic,
    );
    expect(statusPublishes).toHaveLength(0);
    expect(fakeClient.end).toHaveBeenCalledTimes(1);
  });
});
