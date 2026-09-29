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
  STATION_INBOUND_TOPIC,
  startMqttClient,
} from '../mqtt.js';
import type { IncomingEnvelope, QueueDurability, RedisBridge } from '../redis.js';
import { oldestInboundInFlight, resetState, state } from '../state.js';

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
}

const makeFakeRedis = (): FakeRedisBridge => {
  const pushed: IncomingEnvelope[] = [];

  return {
    pushed,
    start: vi.fn((): Promise<void> => Promise.resolve()),
    assertQueueDurable: vi.fn(
      (): Promise<QueueDurability> => Promise.resolve({ durable: true, policy: 'noeviction' }),
    ),
    pushIncoming: vi.fn((env: IncomingEnvelope): Promise<void> => {
      pushed.push(env);
      return Promise.resolve();
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

/** Wraps startMqttClient so the bridge is auto-tracked for afterEach cleanup. */
const start = (
  cfg: Config,
  redis: ReturnType<typeof makeFakeRedis>,
  connector: MqttConnector,
  onFatal: (err: Error) => void = vi.fn(),
): MqttBridge => {
  const bridge = startMqttClient(cfg, redis, silentLogger, connector, onFatal);
  activeBridges.push(bridge);
  return bridge;
};

const flushMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r));

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
    // "persistent session" is clean:false PLUS a non-zero expiry — assert both, so the
    // test name isn't a lie (AUDIT-05 F-02). Dedicated coverage below.
    expect(opts.properties?.sessionExpiryInterval).toBe(3600);
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

  it('advertises the session-persistence CONNECT knobs F-02 needs (necessary, NOT sufficient)', () => {
    // AUDIT-05 F-02. These three config values are NECESSARY for the broker to retain
    // this bridge's session + subscription + queued QoS-1 messages across a disconnect:
    // protocolVersion 5 (MQTT 5), clean:false, and a non-zero Session Expiry Interval
    // (an absent value is treated as ZERO → session deleted on disconnect). This is a
    // config regression guard ONLY — it does NOT prove F-02 is closed. The first ship
    // of ARC 9 passed exactly this assertion and was still broken on the wire, because
    // the subscription was $share/ (EMQX drops offline shared-sub messages as
    // no_subscriber) and stop() unsubscribed. The BEHAVIOURAL guarantee — a QoS-1
    // message published while the bridge is down actually lands in mqtt:incoming after
    // it restarts — is proven ON THE WIRE on UAT, not here. See the plain-subscription
    // and no-unsubscribe-on-stop guards below for the two code-level fixes.
    const opts = buildClientOptions(validConfig);

    expect(opts.protocolVersion).toBe(5);
    expect(opts.clean).toBe(false);
    expect(opts.properties?.sessionExpiryInterval).toBe(3600);
  });

  it('forwards a custom MQTT_SESSION_EXPIRY_INTERVAL', () => {
    const cfg = loadConfig({
      MQTT_BROKER_URL: 'mqtts://broker.test:8884',
      MQTT_CLIENT_ID: 'csms-test-server-1',
      MQTT_CERT_PATH: join(tmpDir, 'cert.pem'),
      MQTT_KEY_PATH: join(tmpDir, 'key.pem'),
      MQTT_CA_PATH: join(tmpDir, 'ca.pem'),
      REDIS_URL: 'redis://redis.test:6379',
      MQTT_SESSION_EXPIRY_INTERVAL: '7200',
    });
    const opts = buildClientOptions(cfg);
    expect(opts.properties?.sessionExpiryInterval).toBe(7200);
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

  it('subscribes to the PLAIN station inbound topic on connect (not $share/) — F-02 fix', async () => {
    const fakeClient = makeFakeClient();
    const connector = vi.fn(
      (_url: string, _opts: IClientOptions) => fakeClient as unknown as MqttClient,
    );

    start(validConfig, makeFakeRedis(), connector);
    fireConnect(fakeClient);
    await flushMicrotasks();

    expect(fakeClient.subscribe).toHaveBeenCalledTimes(1);
    expect(fakeClient.subscribe.mock.calls[0]?.[0]).toBe(STATION_INBOUND_TOPIC);
    // Regression guard: a shared subscription is what broke F-02 (EMQX drops offline
    // shared-sub messages). The topic must be plain — never a `$share/` group.
    expect(fakeClient.subscribe.mock.calls[0]?.[0]).not.toContain('$share/');
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

// ── The inbound grant — what the SUBACK actually gave ───────────────────────
//
// The bridge asked for QoS 1 and never looked at the answer. A SUBACK refusal (a
// reason code >= 0x80) was logged and the bridge ran on subscribed to nothing - still
// connected, still answering /healthz 200, receiving no station message at all. A grant
// DOWNGRADED to QoS 0 was logged as a success: at QoS 0 the broker queues nothing for
// the persistent session and waits for no PUBACK, so the manual ack that withholds the
// PUBACK until the Redis push lands guards nothing. Both are errors the bridge reports
// and does not run past; onFatal is the path that ends the process.

describe('startMqttClient — the inbound grant (SUBACK)', () => {
  const connack: IConnackPacket = {
    cmd: 'connack',
    sessionPresent: false,
    reasonCode: 0,
    returnCode: 0,
  };

  /** A client whose SUBACK answers with the given error and grant, as mqtt.js 5 hands them over. */
  const clientAnswering = (
    err: Error | null,
    granted: ISubscriptionGrant[],
  ): FakeMqttClient => {
    const client = makeFakeClient();
    client.subscribe = vi.fn(
      (
        _topic: string,
        _opts: IClientSubscribeOptions,
        cb: (e: Error | null, g: ISubscriptionGrant[]) => void,
      ) => {
        cb(err, granted);
        return client as unknown as MqttClient;
      },
    );
    return client;
  };

  it('reports a refused subscription and does not run past it', async () => {
    // mqtt.js 5 rejects a SUBACK whose reason code has the 0x80 bit with an
    // ErrorWithSubackPacket that carries the SUBACK itself; 135 is Not authorized,
    // what an ACL deny answers.
    const refusal = Object.assign(new Error('Subscribe error: Not authorized'), {
      packet: { cmd: 'suback', messageId: 1, granted: [135] },
    });
    const client = clientAnswering(refusal, [{ topic: STATION_INBOUND_TOPIC, qos: 1 }]);
    const onFatal = vi.fn();

    start(validConfig, makeFakeRedis(), () => client as unknown as MqttClient, onFatal);
    client.emit('connect', connack);
    await flushMicrotasks();

    expect(onFatal).toHaveBeenCalledTimes(1);
    const reported = onFatal.mock.calls[0]?.[0] as Error;
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toMatch(/refused/i);
    expect(reported.message).toContain('135');
  });

  it('reports a grant downgraded to QoS 0 for the QoS 1 it asked, and does not run past it', async () => {
    const client = clientAnswering(null, [{ topic: STATION_INBOUND_TOPIC, qos: 0 }]);
    const onFatal = vi.fn();

    start(validConfig, makeFakeRedis(), () => client as unknown as MqttClient, onFatal);
    client.emit('connect', connack);
    await flushMicrotasks();

    expect(onFatal).toHaveBeenCalledTimes(1);
    const reported = onFatal.mock.calls[0]?.[0] as Error;
    expect(reported.message).toMatch(/downgraded/i);
    expect(reported.message).toContain('QoS 0');
  });

  it('runs on when the grant is the QoS it asked for', async () => {
    const client = clientAnswering(null, [{ topic: STATION_INBOUND_TOPIC, qos: 1 }]);
    const onFatal = vi.fn();

    start(validConfig, makeFakeRedis(), () => client as unknown as MqttClient, onFatal);
    client.emit('connect', connack);
    await flushMicrotasks();

    expect(onFatal).not.toHaveBeenCalled();
  });

  it('does not read a connection lost before the SUBACK as a refusal - the next connect subscribes again', async () => {
    // mqtt.js flushes a pending SUBSCRIBE with a bare 'Connection closed' error and no
    // SUBACK when the stream closes first. Nothing was refused; the reconnect's own
    // 'connect' subscribes again, and a connection that never comes back is the
    // watchdog's to catch, not this path's.
    const client = clientAnswering(new Error('Connection closed'), [
      { topic: STATION_INBOUND_TOPIC, qos: 1 },
    ]);
    const onFatal = vi.fn();

    start(validConfig, makeFakeRedis(), () => client as unknown as MqttClient, onFatal);
    client.emit('connect', connack);
    await flushMicrotasks();

    expect(onFatal).not.toHaveBeenCalled();
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

  // Characterisation, not a fix: this pins WHY docs/REDIS-QUEUE-CONTRACT.md must not
  // tell consumers to dedupe on the envelope messageId. The bridge mints a fresh UUID
  // per DELIVERY, so a broker re-delivery of the identical packet — the exact recovery
  // scenario the contract names — carries a different envelope messageId and would not
  // match. Deduplication belongs on the OSPP messageId inside the payload, which the
  // bridge never touches. csms-server does exactly that (MessageDispatcher::dispatch() via
  // MessageFactory::fromJson()); the contract text was the only thing that was wrong.
  it('mints a NEW envelope messageId per delivery — so it can never be a dedupe key', async () => {
    const fakeClient = makeFakeClient();
    const fakeRedis = makeFakeRedis();
    start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);

    // The SAME packet delivered twice, as the broker does when an ack is missed.
    const packet = makePacket(
      'ospp/v1/stations/stn_00000001/to-server',
      Buffer.from('{"messageId":"osp-identical","action":"MeterValues"}'),
    );
    await callHandleMessage(fakeClient, packet);
    await callHandleMessage(fakeClient, packet);

    expect(fakeRedis.pushed).toHaveLength(2);
    const [first, second] = fakeRedis.pushed;
    expect(first?.messageId).not.toBe(second?.messageId);
    // …while the OSPP id inside the payload — the usable dedupe key — is identical.
    expect(first?.payload).toBe(second?.payload);
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

  // I-1 observability — Sprint Fix Issues Post-Validation 2026-05-22
  it.each<[string, 'non_compliant_station_id' | 'wrong_topic_format' | 'other']>([
    ['ospp/v1/stations/stn_smoke3fe34372/to-server', 'non_compliant_station_id'],
    ['ospp/v1/stations/stn_00000001/to-server/extra', 'wrong_topic_format'],
    ['random/garbage/topic', 'other'],
  ])(
    'increments topicDropsTotal{reason=%s} when dropping "%s"',
    async (topic, expectedReason) => {
      const { topicDropsTotal } = await import('../metrics.js');
      const readCount = async (reason: string): Promise<number> => {
        const snapshot = await topicDropsTotal.get();
        const found = snapshot.values.find((v) => v.labels.reason === reason);
        return found?.value ?? 0;
      };
      const before = await readCount(expectedReason);

      const fakeClient = makeFakeClient();
      const fakeRedis = makeFakeRedis();
      start(validConfig, fakeRedis, () => fakeClient as unknown as MqttClient);
      const result = await callHandleMessage(fakeClient, makePacket(topic, Buffer.from('x')));

      expect(result).toBeUndefined();
      expect(fakeRedis.pushed).toHaveLength(0);
      expect((await readCount(expectedReason)) - before).toBe(1);
    },
  );

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

// ── What the watchdog reads — the three ways the bridge gets stuck ──────────
//
// The watchdog (src/watchdog.ts) decides from these fields; these tests pin that the
// MQTT side keeps them true. Only Date is faked: the handlers still run on real
// microtasks and setImmediate.

describe('startMqttClient — stuck-state tracking', () => {
  const connack: IConnackPacket = {
    cmd: 'connack',
    sessionPresent: false,
    reasonCode: 0,
    returnCode: 0,
  };
  const inboundTopic = 'ospp/v1/stations/stn_00000001/to-server';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks the broker connection down from the first loss, and up again on connect', () => {
    const client = makeFakeClient();
    start(validConfig, makeFakeRedis(), () => client as unknown as MqttClient);

    vi.setSystemTime(1_000_000);
    client.emit('connect', connack);
    expect(state.mqttDownSince).toBeNull();

    vi.setSystemTime(1_005_000);
    client.emit('close');
    expect(state.mqttDownSince).toBe(1_005_000);

    // mqtt.js follows a close with offline, and reconnect attempts after that; the
    // clock keeps counting from the first loss, not from the latest event.
    vi.setSystemTime(1_006_000);
    client.emit('offline');
    expect(state.mqttDownSince).toBe(1_005_000);

    vi.setSystemTime(1_007_000);
    client.emit('connect', connack);
    expect(state.mqttDownSince).toBeNull();
  });

  it('holds the receipt time of a message whose push has not settled, and clears it when it does', async () => {
    const client = makeFakeClient();
    const redis = makeFakeRedis();
    let settle: () => void = () => undefined;
    redis.pushIncoming = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    start(validConfig, redis, () => client as unknown as MqttClient);

    vi.setSystemTime(2_000_000);
    const acked = callHandleMessage(client, makePacket(inboundTopic, Buffer.from('x')));
    await flushMicrotasks();

    expect(oldestInboundInFlight()).toBe(2_000_000);

    settle();
    expect(await acked).toBeUndefined();
    expect(oldestInboundInFlight()).toBeNull();
  });

  it('records the first message left unacknowledged on this connection, until a new connection', async () => {
    const client = makeFakeClient();
    const redis = makeFakeRedis();
    redis.pushIncoming = vi.fn((): Promise<void> => Promise.reject(new Error('OOM')));
    start(validConfig, redis, () => client as unknown as MqttClient);
    client.emit('connect', connack);

    vi.setSystemTime(3_000_000);
    expect(await callHandleMessage(client, makePacket(inboundTopic, Buffer.from('a')))).toBeInstanceOf(
      Error,
    );
    expect(state.unackedSince).toBe(3_000_000);
    expect(oldestInboundInFlight()).toBeNull();

    // A later refusal does not move the clock, and a later SUCCESS does not clear it:
    // the first message is still unacknowledged, and the broker resends it only on a
    // new connection (retry_interval = infinity on the deployed broker).
    vi.setSystemTime(3_010_000);
    await callHandleMessage(client, makePacket(inboundTopic, Buffer.from('b')));
    redis.pushIncoming = vi.fn((): Promise<void> => Promise.resolve());
    vi.setSystemTime(3_020_000);
    expect(await callHandleMessage(client, makePacket(inboundTopic, Buffer.from('c')))).toBeUndefined();
    expect(state.unackedSince).toBe(3_000_000);

    client.emit('close');
    client.emit('connect', connack);
    expect(state.unackedSince).toBeNull();
  });
});

describe('startMqttClient — stop()', () => {
  it('does NOT unsubscribe on stop (keeps the subscription in the retained session) — F-02 fix', async () => {
    const fakeClient = makeFakeClient();
    const bridge = start(validConfig, makeFakeRedis(), () => fakeClient as unknown as MqttClient);

    // Force connected state so stop() runs the offline path.
    state.mqttConnected = true;

    await bridge.stop();

    // Regression guard for the second half of the F-02 fix: unsubscribing on shutdown
    // removes the subscription from the persistent session, so QoS-1 messages published
    // during the (usual) restart window would not be queued and would be lost — the exact
    // failure. The bridge restarts far more often than it disappears, so it MUST keep the
    // subscription; a genuinely permanent shutdown self-cleans via sessionExpiryInterval.
    expect(fakeClient.unsubscribe).not.toHaveBeenCalled();

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
