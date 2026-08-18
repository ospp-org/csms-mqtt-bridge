import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import mqtt from 'mqtt';
import type {
  DoneCallback,
  IClientOptions,
  IConnackPacket,
  IDisconnectPacket,
  IPublishPacket,
  MqttClient,
} from 'mqtt';
import type { Logger } from 'pino';

import type { Config } from './config.js';
import { classifyDropReason, inboundPushFailuresTotal, topicDropsTotal } from './metrics.js';
import type { IncomingEnvelope, RedisBridge } from './redis.js';
import { ENVELOPE_VERSION } from './redis.js';
import { state } from './state.js';

/**
 * Station→server inbound topic filter — a PLAIN (non-shared) subscription.
 *
 * AUDIT-05 F-02, fix-forward (2026-07-13): this was a shared subscription
 * (`$share/ospp-servers/…`). On-wire UAT proof showed that when the lone
 * shared-group member (this bridge) is offline, EMQX drops matching QoS-1
 * messages as `no_subscriber` — a shared subscription is NOT retained/queued
 * for an offline member, so `sessionExpiryInterval` alone could not close F-02.
 * A plain subscription on a persistent session (clean:false + expiry) IS queued
 * by the broker while the bridge is offline and redelivered on reconnect —
 * standard MQTT session semantics.
 *
 * `$share/` bought nothing here: it load-balances across N consumers and there
 * is one. HA is unaffected — run N bridges each with its own clientId + plain
 * subscription: every instance receives every message, and MessageDispatcher's
 * per-station dedup (AUDIT-05 F-04 / ARC 3, kept intact by ARC 8b) suppresses
 * the duplicates server-side, where the guarantee is already proven. The cost
 * ($share drops on offline) is removed; the benefit (dedup) is unchanged.
 */
export const STATION_INBOUND_TOPIC = 'ospp/v1/stations/+/to-server';

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
  // MQTT 5 CONNECT properties. sessionExpiryInterval is the companion to clean:false —
  // it keeps this bridge's session, its PLAIN subscription (STATION_INBOUND_TOPIC), and
  // the QoS-1 messages the broker queues for that subscription, alive across a brief
  // disconnect. Without it the session expiry defaults to 0 and the session (with its
  // subscription + queued messages) is deleted on disconnect, so station→server messages
  // published during a bridge partition are acked-and-dropped (AUDIT-05 F-02). NB: expiry
  // is necessary but NOT sufficient — F-02 also required the subscription to be plain
  // (not $share/, which EMQX never queues for an offline member) and stop() to NOT
  // unsubscribe on shutdown (which would remove the subscription from the retained session).
  properties: { sessionExpiryInterval: config.MQTT_SESSION_EXPIRY_INTERVAL },
  keepalive: config.MQTT_KEEPALIVE,
  reconnectPeriod: config.MQTT_RECONNECT_PERIOD,
  connectTimeout: config.MQTT_CONNECT_TIMEOUT,
  cert: readFileSync(config.MQTT_CERT_PATH),
  key: readFileSync(config.MQTT_KEY_PATH),
  // When MQTT_CA_PATH is unset, mqtt.js / tls.connect fall back to Node's
  // default trust (system CA bundle). Useful when the broker presents a
  // certificate signed by a publicly-trusted CA (e.g. Let's Encrypt).
  ...(config.MQTT_CA_PATH === undefined ? {} : { ca: readFileSync(config.MQTT_CA_PATH) }),
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
 * so the broker re-delivers on reconnect.
 */
const handleInbound = async (
  packet: IPublishPacket,
  redis: RedisBridge,
  logger: Logger,
): Promise<void> => {
  const topic = packet.topic;
  const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);

  const stationId = parseStationFromTopic(topic);
  if (stationId === null) {
    // Acking on drop is intentional — a "garbage" topic should not be redelivered
    // on every reconnect. Counter + structured log let ops detect the silent-drop
    // case from outside (Sprint Manual Validation Prod 2026-05-22, I-1 finding:
    // operator hit a 15s sim timeout with no operator-visible cause because the
    // warn-level log was the only signal and there was no metric to alert on).
    const reason = classifyDropReason(topic);
    topicDropsTotal.inc({ reason });
    logger.warn(
      {
        event: 'topic_dropped',
        topic,
        reason,
        mqttPacketId: packet.messageId ?? null,
      },
      'received message on unexpected topic, dropping (will ack)',
    );
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

const registerLifecycleListeners = (client: MqttClient, config: Config, logger: Logger): void => {
  const statusTopic = serverStatusTopicFor(config.MQTT_CLIENT_ID);

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

    client.subscribe(STATION_INBOUND_TOPIC, { qos: 1 }, (err, granted) => {
      if (err) {
        logger.error({ err }, 'subscribe failed');
        return;
      }
      // Idempotent: on a resumed session (sessionPresent:true) the subscription
      // already exists; re-subscribing is a no-op that just re-confirms the grant.
      logger.info({ granted }, 'subscribed to station inbound topic');
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
        // Counted, not just logged: a refused write is the HEALTHY failure (the
        // broker keeps the message), but it is indistinguishable from silence
        // unless something outside the process can see it. Under `noeviction`
        // this is what memory pressure looks like; under an eviction policy the
        // write would have succeeded and the message would be gone instead.
        inboundPushFailuresTotal.inc();
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

  registerLifecycleListeners(client, config, logger);
  installManualAck(client, redis, logger);

  const stop = async (): Promise<void> => {
    logger.info('mqtt bridge stopping');

    if (state.mqttConnected) {
      // Deliberately do NOT unsubscribe here. This bridge shuts down to RESTART
      // (deploy) far more often than to disappear. Unsubscribing removes the
      // subscription from the persistent session, so QoS-1 station→server messages
      // published during the restart window would not be queued and would be lost —
      // the exact AUDIT-05 F-02 failure. Leaving the subscription in place lets the
      // broker queue those messages and redeliver them on reconnect. A genuinely
      // permanent shutdown self-cleans when the session expires (sessionExpiryInterval).
      // The LWT (will) plus this explicit publish still announce the bridge offline.
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

    await new Promise<void>((resolve) => {
      client.end(false, {}, () => {
        resolve();
      });
    });

    logger.info('mqtt bridge stopped');
  };

  return { client, stop };
};
