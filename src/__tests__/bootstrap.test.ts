import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { bootstrap } from '../bootstrap.js';
import type { Config } from '../config.js';
import type { MqttBridge } from '../mqtt.js';
import type { RedisBridge } from '../redis.js';
import { createRedisBridge } from '../redis.js';

const makeRedis = (over: Partial<RedisBridge> = {}): RedisBridge =>
  ({
    start: vi.fn((): Promise<void> => Promise.resolve()),
    assertQueueDurable: vi.fn((): Promise<void> => Promise.resolve()),
    pushIncoming: vi.fn(),
    quit: vi.fn(),
    isReady: vi.fn(() => true),
    ...over,
  });

const silent = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('bootstrap — ordered startup', () => {
  it('starts Redis, asserts durability, THEN starts MQTT — in that order', async () => {
    const calls: string[] = [];
    const redis = makeRedis({
      start: vi.fn(() => {
        calls.push('start');
        return Promise.resolve();
      }),
      assertQueueDurable: vi.fn(() => {
        calls.push('assert');
        return Promise.resolve();
      }),
    });
    const startMqtt = vi.fn((): MqttBridge => {
      calls.push('mqtt');
      return {} as MqttBridge;
    });

    await bootstrap({ redis, startMqtt, logger: silent });

    expect(calls).toEqual(['start', 'assert', 'mqtt']);
  });

  // The whole point of the guard: if the queue can evict, the bridge must never
  // reach the broker. A bridge that connects first and dies second has already
  // ack'd — and lost — whatever arrived in the window.
  it('does NOT start MQTT when the durability assertion rejects', async () => {
    const redis = makeRedis({
      assertQueueDurable: vi.fn(() => Promise.reject(new Error('allkeys-lru'))),
    });
    const startMqtt = vi.fn((): MqttBridge => ({}) as MqttBridge);

    await expect(bootstrap({ redis, startMqtt, logger: silent })).rejects.toThrow(/allkeys-lru/);
    expect(startMqtt).not.toHaveBeenCalled();
  });

  it('does NOT start MQTT when Redis fails to connect', async () => {
    const redis = makeRedis({
      start: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    });
    const startMqtt = vi.fn((): MqttBridge => ({}) as MqttBridge);

    await expect(bootstrap({ redis, startMqtt, logger: silent })).rejects.toThrow(/ECONNREFUSED/);
    expect(startMqtt).not.toHaveBeenCalled();
  });

  it('does NOT assert durability when Redis never connected', async () => {
    const assertQueueDurable = vi.fn((): Promise<void> => Promise.resolve());
    const redis = makeRedis({
      start: vi.fn(() => Promise.reject(new Error('down'))),
      assertQueueDurable,
    });
    await expect(
      bootstrap({ redis, startMqtt: () => ({}) as MqttBridge, logger: silent }),
    ).rejects.toThrow();
    expect(assertQueueDurable).not.toHaveBeenCalled();
  });

  it('returns the MQTT bridge on success', async () => {
    const handle = { client: {}, stop: vi.fn() } as unknown as MqttBridge;
    const result = await bootstrap({
      redis: makeRedis(),
      startMqtt: () => handle,
      logger: silent,
    });
    expect(result).toBe(handle);
  });
});

// REDIS_REQUIRE_NOEVICTION=false downgrades the durability refusal: assertQueueDurable()
// logs a [QUEUE_DURABILITY] warning and resolves. bootstrap then logged 'queue durability
// asserted (maxmemory-policy=noeviction)' whatever the policy was, so the line after the
// warning said the opposite of it. These cases run the real createRedisBridge over a fake
// ioredis client, so the startup line is checked against what the check found.

const ASSERTED = 'queue durability asserted (maxmemory-policy=noeviction)';

/** Only what createRedisBridge reads when a client is injected. */
const configWith = (requireNoeviction: boolean): Config =>
  ({ REDIS_REQUIRE_NOEVICTION: requireNoeviction }) as unknown as Config;

const fakeClient = (policyReply: () => Promise<unknown>): Redis =>
  ({ status: 'ready', config: vi.fn(policyReply) }) as unknown as Redis;

const makeLogger = () => ({
  info: vi.fn<(...args: unknown[]) => void>(),
  warn: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
  fatal: vi.fn<(...args: unknown[]) => void>(),
  debug: vi.fn<(...args: unknown[]) => void>(),
});

/** The message of each call; pino takes (msg) or (obj, msg). */
const messages = (fn: ReturnType<typeof makeLogger>['info']): string[] =>
  fn.mock.calls.map((args) => args.filter((a) => typeof a === 'string').join(' '));

describe('bootstrap - the startup line says what the durability check found', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['allkeys-lru', () => Promise.resolve(['maxmemory-policy', 'allkeys-lru'])],
    ['undeterminable', () => Promise.reject(new Error('ERR unknown command'))],
  ])(
    'with the refusal downgraded and maxmemory-policy=%s, does NOT log durability as asserted, warns naming the policy, and still starts MQTT',
    async (policy, policyReply) => {
      const logger = makeLogger();
      const log = logger as unknown as Logger;
      const redis = createRedisBridge(configWith(false), {
        client: fakeClient(policyReply),
        logger: log,
      });
      const startMqtt = vi.fn((): MqttBridge => ({}) as MqttBridge);

      await bootstrap({ redis, startMqtt, logger: log });

      expect(messages(logger.info)).not.toContain(ASSERTED);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ policy, redisRequireNoeviction: false }),
        expect.stringMatching(
          new RegExp(
            `^queue durability NOT asserted \\(maxmemory-policy=${policy}\\).*REDIS_REQUIRE_NOEVICTION=false`,
          ),
        ),
      );
      // A downgrade is a warning, not a refusal: the bridge still starts.
      expect(startMqtt).toHaveBeenCalledOnce();
    },
  );

  // The control: the line is still logged when it is true, whichever way the flag is set,
  // so the case above cannot pass merely because the line is never logged.
  it.each([true, false])(
    'control: with maxmemory-policy=noeviction and REDIS_REQUIRE_NOEVICTION=%s, logs durability as asserted and warns nothing',
    async (requireNoeviction) => {
      const logger = makeLogger();
      const log = logger as unknown as Logger;
      const redis = createRedisBridge(configWith(requireNoeviction), {
        client: fakeClient(() => Promise.resolve(['maxmemory-policy', 'noeviction'])),
        logger: log,
      });

      await bootstrap({ redis, startMqtt: () => ({}) as MqttBridge, logger: log });

      expect(messages(logger.info)).toContain(ASSERTED);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );
});
