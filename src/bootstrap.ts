import type { Logger } from 'pino';

import type { MqttBridge } from './mqtt.js';
import type { RedisBridge } from './redis.js';

export interface BootstrapDeps {
  redis: RedisBridge;
  /** Deferred so the MQTT client is constructed only after Redis is proven usable. */
  startMqtt: () => MqttBridge;
  logger: Logger;
}

/**
 * Ordered startup. The order is load-bearing, not cosmetic:
 *
 *  1. `redis.start()` — resolves on 'ready'. Both the inbound push and the
 *     outbound loop need the connection.
 *  2. `redis.assertQueueDurable()` — refuse a queue Redis that can evict.
 *  3. only then construct the MQTT client, which immediately subscribes.
 *
 * Steps 2 and 3 must not be reordered or run concurrently. The MQTT client acks
 * to the broker as soon as a push resolves, so a bridge that connects first and
 * fails the durability check second has already ack'd — and, under an eviction
 * policy, already lost — everything that arrived in that window. Refusing to
 * start is only a safe refusal if nothing was accepted first.
 *
 * This replaces a fire-and-forget `void (async () => { await redis.start() })()`
 * that was followed by an unconditional, synchronous `startMqttClient(...)`: the
 * documented ordering was never actually implemented, and only the ioredis
 * offline queue kept it from misbehaving. Reported in csms-server
 * docs/audits/adjudication/RECON-WIRE-LIFECYCLES.md:1345-1346.
 */
export const bootstrap = async ({ redis, startMqtt, logger }: BootstrapDeps): Promise<MqttBridge> => {
  await redis.start();
  logger.info('redis ready; asserting queue durability before touching the broker');

  await redis.assertQueueDurable();
  logger.info('queue durability asserted (maxmemory-policy=noeviction)');

  return startMqtt();
};
