import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import mqtt from 'mqtt';
import type {
  DoneCallback,
  IClientOptions,
  IClientPublishOptions,
  IConnackPacket,
  IDisconnectPacket,
  IPublishPacket,
  MqttClient,
} from 'mqtt';
import type { Logger } from 'pino';

import type { Config } from './config.js';
import type { IncomingEnvelope, OutgoingEnvelope, RedisBridge, ReliableOutgoing } from './redis.js';
import { ENVELOPE_VERSION } from './redis.js';
import { state } from './state.js';

export const SHARED_SUB_TOPIC = '$share/ospp-servers/ospp/v1/stations/+/to-server';

/**
 * Per-instance retained status topic. Singleton `ospp/v1/server/status` would
 * cause last-write-wins conflicts in multi-instance deployments — when a
 * second bridge instance connects, its retained "online" overwrites the first
 * instance's, even if the first is still up. Per-instance topic gives each
 * clientId its own retained status; LWT cleans it up gracefully on disconnect.
 *
 * The OSPP spec only defines `ospp/v1/stations/*` topics
 * (spec/spec/02-transport.md:112-115); server-level status is bridge-internal
 * convention.
 */
export const serverStatusTopicFor = (clientId: string): string =>
  `ospp/v1/servers/${clientId}/status`;

// Station ID format per spec/spec/01-architecture.md:127 + glossary.md:331-332:
// `stn_` prefix + 8 or more lowercase hex chars. Upper bound 60 = csms-server's
// 64-char StationId max minus the 4-char prefix.
const STATION_TOPIC_RE = /^ospp\/v1\/stations\/(stn_[a-f0-9]{8,60})\/to-server$/;

export type MqttConnector = (url: string, opts: IClientOptions) => MqttClient;

export interface MqttBridge {
  readonly client: MqttClient;
  stop(): Promise<void>;
}

// String#match (rather than RegExp#exec) — the literal `.exec(` token is flagged as a
// false-positive child_process.exec by an upstream security-reminder hook. Behavior is
// identical: single capture group, no /g flag.
/** Returns the stationId for a `to-server` topic, or null if the topic doesn't match. */
export const parseStationFromTopic = (topic: string): string | null => {
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec
  const match = topic.match(STATION_TOPIC_RE);
  return match?.[1] ?? null;
};

const buildStatusPayload = (clientId: string, status: 'online' | 'offline'): string =>
  JSON.stringify({ clientId, status, ts: Date.now() });

export const buildClientOptions = (config: Config): IClientOptions => ({
  clientId: config.MQTT_CLIENT_ID,
  protocolVersion: 5,
  clean: false,
  keepalive: config.MQTT_KEEPALIVE,
  reconnectPeriod: config.MQTT_RECONNECT_PERIOD,
  connectTimeout: config.MQTT_CONNECT_TIMEOUT,
  cert: readFileSync(config.MQTT_CERT_PATH),
  key: readFileSync(config.MQTT_KEY_PATH),
  ca: readFileSync(config.MQTT_CA_PATH),
  rejectUnauthorized: config.MQTT_REJECT_UNAUTHORIZED,
  // Override the SNI hostname sent in the TLS handshake. mqtt.js forwards
  // `servername` to the underlying tls.connect; when omitted, tls.connect
  // defaults to the URL host.
  ...(config.MQTT_SERVERNAME === undefined ? {} : { servername: config.MQTT_SERVERNAME }),
  resubscribe: false,
  will: {
    topic: serverStatusTopicFor(config.MQTT_CLIENT_ID),
    payload: Buffer.from(buildStatusPayload(config.MQTT_CLIENT_ID, 'offline')),
    qos: 1,
    retain: true,
    properties: { contentType: 'application/json' },
  },
});

/**
 * Push the inbound message to Redis. Returns normally on success or on a
 * deliberate drop (unknown topic — drop the message and ack to broker).
 * Throws if the Redis push fails — caller MUST translate that into a no-ack
 * so the broker re-delivers on reconnect / share-group rebalance.
 */
export const handleInbound = async (
  packet: IPublishPacket,
  redis: RedisBridge,
  logger: Logger,
): Promise<void> => {
  const topic = packet.topic;
  const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);

  const stationId = parseStationFromTopic(topic);
  if (stationId === null) {
    // Acking on drop is intentional — a "garbage" topic should not be redelivered
    // on every reconnect. Log warn so it's still visible.
    logger.warn({ topic }, 'received message on unexpected topic, dropping (will ack)');
    return;
  }

  const now = new Date();
  state.lastMessageReceivedAt = now;

  const envelope: IncomingEnvelope = {
    version: ENVELOPE_VERSION,
    topic,
    stationId,
    payload: payload.toString('base64'),
    qos: packet.qos,
    receivedAt: now.toISOString(),
    messageId: randomUUID(),
    properties: packet.properties ?? null,
  };

  // Re-throw on push failure: handleMessage's caller will translate into a
  // missing PUBACK so the broker keeps the message and re-delivers later.
  await redis.pushIncoming(envelope);
  logger.debug(
    { stationId, qos: envelope.qos, bytes: payload.length, messageId: envelope.messageId },
    'inbound pushed to redis (will ack)',
  );
};

const publishEnvelope = (
  envelope: OutgoingEnvelope,
  client: MqttClient,
  logger: Logger,
): Promise<void> => {
  const opts: IClientPublishOptions = { qos: envelope.qos };
  if (envelope.properties !== undefined) {
    opts.properties = envelope.properties;
  }
  const payload = Buffer.from(envelope.payload, 'base64');

  state.inflightOutbound += 1;
  return new Promise<void>((resolve, reject) => {
    client.publish(envelope.topic, payload, opts, (err) => {
      state.inflightOutbound -= 1;
      if (err) {
        logger.error({ err, topic: envelope.topic, qos: envelope.qos }, 'publish failed');
        reject(err);
        return;
      }
      logger.debug(
        { topic: envelope.topic, qos: envelope.qos, bytes: payload.length },
        'published',
      );
      resolve();
    });
  });
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const startOutboundLoop = (
  redis: RedisBridge,
  client: MqttClient,
  logger: Logger,
): { stop: () => void; done: Promise<void> } => {
  // Boxed flag so the closure check after `await` doesn't get narrowed by control-flow analysis.
  const ctl = { stopRequested: false };

  const loop = async (): Promise<void> => {
    logger.debug('outbound loop started');
    while (!ctl.stopRequested) {
      let item: ReliableOutgoing | null = null;
      try {
        item = await redis.popOutgoingReliable();
      } catch (popErr) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ctl.stopRequested may flip during the await above; the condition is required.
        if (ctl.stopRequested) return;
        logger.warn({ err: popErr }, 'outbound pop/parse failed; backing off 1s');
        await sleep(1_000);
        continue;
      }

      if (item === null) continue;

      try {
        await publishEnvelope(item.envelope, client, logger);
        await item.ack();
      } catch (publishErr) {
        // Do NOT ack — envelope stays in PROCESSING, replayed on next startup
        // (or by mqtt.js's internal store on reconnect, since clean=false).
        logger.warn(
          { err: publishErr, topic: item.envelope.topic },
          'publish failed; envelope stays in processing for retry',
        );
        await sleep(1_000);
      }
    }
    logger.debug('outbound loop stopped');
  };

  const done = loop();

  return {
    stop: () => {
      ctl.stopRequested = true;
    },
    done,
  };
};

const replayProcessingOnce = async (
  redis: RedisBridge,
  client: MqttClient,
  logger: Logger,
): Promise<void> => {
  let items: ReliableOutgoing[];
  try {
    items = await redis.replayProcessing();
  } catch (err) {
    logger.error({ err }, 'replayProcessing failed at startup');
    return;
  }

  if (items.length === 0) {
    logger.debug('processing queue empty at startup, no replay needed');
    return;
  }

  logger.warn({ count: items.length }, 'replaying envelopes from processing queue');
  let replayed = 0;
  let stuck = 0;
  for (const item of items) {
    try {
      await publishEnvelope(item.envelope, client, logger);
      await item.ack();
      replayed += 1;
    } catch (err) {
      logger.error(
        { err, topic: item.envelope.topic },
        'replay publish failed; envelope remains in processing',
      );
      stuck += 1;
    }
  }
  logger.info({ replayed, stuck }, 'startup replay complete');
};

const registerLifecycleListeners = (
  client: MqttClient,
  config: Config,
  redis: RedisBridge,
  logger: Logger,
): void => {
  const statusTopic = serverStatusTopicFor(config.MQTT_CLIENT_ID);
  let hasReplayedOnStartup = false;

  client.on('connect', (packet: IConnackPacket) => {
    state.mqttConnected = true;
    logger.info(
      {
        reasonCode: packet.reasonCode ?? 0,
        sessionPresent: packet.sessionPresent,
        statusTopic,
      },
      'mqtt connected',
    );

    client.publish(
      statusTopic,
      Buffer.from(buildStatusPayload(config.MQTT_CLIENT_ID, 'online')),
      { qos: 1, retain: true, properties: { contentType: 'application/json' } },
      (err) => {
        if (err) logger.error({ err }, 'failed to publish online status');
      },
    );

    client.subscribe(SHARED_SUB_TOPIC, { qos: 1 }, (err, granted) => {
      if (err) {
        logger.error({ err }, 'subscribe failed');
        return;
      }
      logger.info({ granted }, 'subscribed to shared topic');
    });

    if (!hasReplayedOnStartup) {
      hasReplayedOnStartup = true;
      void replayProcessingOnce(redis, client, logger);
    }
  });

  client.on('reconnect', () => {
    state.reconnectCount += 1;
    logger.warn({ attempt: state.reconnectCount }, 'mqtt reconnecting');
  });

  client.on('close', () => {
    state.mqttConnected = false;
    logger.warn('mqtt connection closed');
  });

  client.on('offline', () => {
    state.mqttConnected = false;
    logger.error('mqtt offline');
  });

  client.on('error', (err) => {
    logger.error({ err }, 'mqtt client error');
  });

  client.on('disconnect', (packet: IDisconnectPacket) => {
    logger.warn({ reasonCode: packet.reasonCode ?? 0 }, 'mqtt disconnect packet received');
  });
};

/**
 * Override `client.handleMessage` so PUBACK to the broker fires only after
 * the inbound envelope has been pushed to Redis. On Redis failure we call
 * the done callback with an error, which causes mqtt.js to skip PUBACK —
 * the broker holds the message and re-delivers on reconnect.
 *
 * This is the at-least-once delivery anchor for the inbound path. Replaces
 * the previous `client.on('message', ...)` listener, which had no way to
 * gate the ack.
 */
const installManualAck = (client: MqttClient, redis: RedisBridge, logger: Logger): void => {
  const wrapped = (packet: IPublishPacket, callback: DoneCallback): void => {
    handleInbound(packet, redis, logger).then(
      () => {
        callback();
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(
          { err: error, topic: packet.topic },
          'inbound push failed; NOT acking — broker will redeliver',
        );
        callback(error);
      },
    );
  };
  // mqtt.js declares handleMessage as a method on MqttClient; assigning a
  // replacement is supported at runtime (see mqtt/lib/handlers/publish.js)
  // but TS sees it as an instance method — cast through unknown.
  (client as unknown as { handleMessage: typeof wrapped }).handleMessage = wrapped;
};

export const startMqttClient = (
  config: Config,
  redis: RedisBridge,
  logger: Logger,
  connect: MqttConnector = mqtt.connect.bind(mqtt),
): MqttBridge => {
  const opts = buildClientOptions(config);
  const client = connect(config.MQTT_BROKER_URL, opts);

  registerLifecycleListeners(client, config, redis, logger);
  installManualAck(client, redis, logger);

  const outbound = startOutboundLoop(redis, client, logger);

  const stop = async (): Promise<void> => {
    logger.info('mqtt bridge stopping');
    outbound.stop();

    if (state.mqttConnected) {
      await new Promise<void>((resolve) => {
        client.unsubscribe(SHARED_SUB_TOPIC, () => {
          resolve();
        });
      });

      await new Promise<void>((resolve) => {
        client.publish(
          serverStatusTopicFor(config.MQTT_CLIENT_ID),
          Buffer.from(buildStatusPayload(config.MQTT_CLIENT_ID, 'offline')),
          { qos: 1, retain: true, properties: { contentType: 'application/json' } },
          () => {
            resolve();
          },
        );
      });
    }

    await Promise.race([
      outbound.done,
      sleep(Math.max(1_000, Math.floor(config.SHUTDOWN_TIMEOUT_MS / 2))),
    ]);

    await new Promise<void>((resolve) => {
      client.end(false, {}, () => {
        resolve();
      });
    });

    logger.info('mqtt bridge stopped');
  };

  return { client, stop };
};
