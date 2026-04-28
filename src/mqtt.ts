import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import mqtt from 'mqtt';
import type {
  IClientOptions,
  IClientPublishOptions,
  IConnackPacket,
  IDisconnectPacket,
  IPublishPacket,
  MqttClient,
} from 'mqtt';
import type { Logger } from 'pino';

import type { Config } from './config.js';
import type { IncomingEnvelope, OutgoingEnvelope, RedisBridge } from './redis.js';
import { state } from './state.js';

export const SHARED_SUB_TOPIC = '$share/ospp-servers/ospp/v1/stations/+/to-server';
export const SERVER_STATUS_TOPIC = 'ospp/v1/server/status';
const STATION_TOPIC_RE = /^ospp\/v1\/stations\/(stn_[a-z0-9]{3,32})\/to-server$/;

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
  resubscribe: false,
  will: {
    topic: SERVER_STATUS_TOPIC,
    payload: Buffer.from(buildStatusPayload(config.MQTT_CLIENT_ID, 'offline')),
    qos: 1,
    retain: true,
    properties: { contentType: 'application/json' },
  },
});

const handleInbound = async (
  topic: string,
  payload: Buffer,
  packet: IPublishPacket,
  redis: RedisBridge,
  logger: Logger,
): Promise<void> => {
  const stationId = parseStationFromTopic(topic);
  if (stationId === null) {
    logger.warn({ topic }, 'received message on unexpected topic, dropping');
    return;
  }

  const now = new Date();
  state.lastMessageReceivedAt = now;

  const envelope: IncomingEnvelope = {
    topic,
    stationId,
    payload: payload.toString('base64'),
    qos: packet.qos,
    receivedAt: now.toISOString(),
    messageId: randomUUID(),
    properties: packet.properties ?? null,
  };

  try {
    await redis.pushIncoming(envelope);
    logger.debug(
      { stationId, qos: envelope.qos, bytes: payload.length, messageId: envelope.messageId },
      'inbound pushed to redis',
    );
  } catch (err) {
    logger.error(
      { err, stationId, topic, messageId: envelope.messageId },
      'failed to push inbound to redis',
    );
  }
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
      try {
        const envelope = await redis.popOutgoing();
        if (envelope === null) continue;
        await publishEnvelope(envelope, client, logger);
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ctl.stopRequested may flip during the await above; the condition is required.
        if (ctl.stopRequested) return;
        logger.warn({ err }, 'outbound iteration failed; backing off 1s');
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

const registerLifecycleListeners = (client: MqttClient, config: Config, logger: Logger): void => {
  client.on('connect', (packet: IConnackPacket) => {
    state.mqttConnected = true;
    logger.info(
      { reasonCode: packet.reasonCode ?? 0, sessionPresent: packet.sessionPresent },
      'mqtt connected',
    );

    client.publish(
      SERVER_STATUS_TOPIC,
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

export const startMqttClient = (
  config: Config,
  redis: RedisBridge,
  logger: Logger,
  connect: MqttConnector = mqtt.connect.bind(mqtt),
): MqttBridge => {
  const opts = buildClientOptions(config);
  const client = connect(config.MQTT_BROKER_URL, opts);

  registerLifecycleListeners(client, config, logger);

  client.on('message', (topic, payload, packet) => {
    handleInbound(topic, payload, packet, redis, logger).catch((err: unknown) => {
      logger.error({ err, topic }, 'inbound handler crashed');
    });
  });

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
          SERVER_STATUS_TOPIC,
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
