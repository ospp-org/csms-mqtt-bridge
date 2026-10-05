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
 *  1. `redis.start()` — resolves on 'ready'. The durability check and the inbound
 *     push both need the connection.
 *  2. `redis.assertQueueDurable()` — refuse a queue Redis that can evict. With
 *     REDIS_REQUIRE_NOEVICTION=false it warns instead and startup goes on; the
 *     startup line then says durability was NOT asserted and names the policy.
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
 * docs/audits/adjudication/RECON-WIRE-LIFECYCLES.md, under its ORDERING heading.
 */
export const bootstrap = async ({
  redis,
  startMqtt,
  logger,
}: BootstrapDeps): Promise<MqttBridge> => {
  await redis.start();
  logger.info('redis ready; asserting queue durability before touching the broker');

  const durability = await redis.assertQueueDurable();
  if (durability.durable) {
    logger.info('queue durability asserted (maxmemory-policy=noeviction)');
  } else {
    logger.warn(
      { policy: durability.policy, redisRequireNoeviction: false },
      `queue durability NOT asserted (maxmemory-policy=${durability.policy}); REDIS_REQUIRE_NOEVICTION=false downgraded the refusal, starting anyway`,
    );
  }

  return startMqtt();
};
