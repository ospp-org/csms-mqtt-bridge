import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { Config } from './config.js';
import { queueDurabilityViolationsTotal } from './metrics.js';
import { state } from './state.js';

type Qos = 0 | 1 | 2;

/**
 * Schema version for envelopes flowing across the bridge → csms-server
 * Redis-queue boundary. Incompatible schema changes MUST bump this; the consumer
 * rejects unknown versions cleanly. The authoritative contract is documented in
 * docs/REDIS-QUEUE-CONTRACT.md.
 */
export const ENVELOPE_VERSION = 1 as const;
type EnvelopeVersion = typeof ENVELOPE_VERSION;

export interface IncomingEnvelope {
  version: EnvelopeVersion;
  topic: string;
  stationId: string;
  payload: string;
  qos: Qos;
  receivedAt: string;
  messageId: string;
  properties: Record<string, unknown> | null;
}

export interface RedisBridge {
  /**
   * Connect (lazyConnect) and wait until the client is ready. Idempotent: a
   * second call after ready resolves immediately.
   */
  start(): Promise<void>;
  /**
   * Assert the queue Redis cannot evict the queue. Reads `maxmemory-policy` and
   * rejects unless it is `noeviction`.
   *
   * Fails CLOSED: if the policy cannot be determined (CONFIG GET rejected by ACL,
   * renamed, or answering an unexpected shape) that is treated as unsafe, never
   * as safe. An undeterminable policy is exactly as dangerous as a known-bad one.
   *
   * With REDIS_REQUIRE_NOEVICTION=false this warns and counts instead of
   * rejecting. It never makes the underlying loss safe.
   */
  assertQueueDurable(): Promise<void>;
  pushIncoming(envelope: IncomingEnvelope): Promise<void>;
  quit(): Promise<void>;
  isReady(): boolean;
}

/** Exponential backoff capped at 30s, with mild jitter to avoid thundering herd. */
const retryStrategy = (times: number): number => {
  const base = Math.min(30_000, 100 * Math.pow(2, times - 1));
  const jitter = Math.floor(Math.random() * 200);
  return base + jitter;
};

const wireLifecycleEvents = (redis: Redis, logger: Logger, label: string): void => {
  redis.on('connect', () => {
    logger.debug({ client: label }, 'redis socket connected');
  });
  redis.on('ready', () => {
    state.redisConnected = true;
    logger.info({ client: label }, 'redis ready');
  });
  redis.on('reconnecting', (delayMs: number) => {
    logger.warn({ client: label, delayMs }, 'redis reconnecting');
  });
  redis.on('error', (err: Error) => {
    logger.error({ client: label, err }, 'redis client error');
  });
  redis.on('close', () => {
    state.redisConnected = false;
    logger.warn({ client: label }, 'redis connection closed');
  });
  redis.on('end', () => {
    state.redisConnected = false;
    logger.warn({ client: label }, 'redis connection ended');
  });
};

/**
 * ioredis answers CONFIG GET with a FLAT array — `['maxmemory-policy', 'noeviction']`
 * — not the keyed map phpredis hands csms-server. Reading it as a map (as the
 * server-side guard does, correctly for its own client) would yield undefined here
 * on every call, so the guard would fail closed against every Redis including a
 * correct one: a gate right in mechanism and blind in vocabulary. Verified against
 * a live redis:7-alpine before this was written.
 *
 * Returns null when the reply is not the expected shape, which callers treat as
 * "undeterminable" — never as "fine".
 */
const readPolicyReply = (reply: unknown): string | null => {
  if (!Array.isArray(reply)) return null;
  const idx = reply.indexOf('maxmemory-policy');
  if (idx === -1) return null;
  const value: unknown = reply[idx + 1];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const UNDETERMINABLE = 'undeterminable';

interface CreateRedisBridgeOpts {
  /** Inject a pre-built ioredis client (tests). When provided, no listeners are wired. */
  client?: Redis;
  /** Logger for lifecycle events. Required when `client` is not provided. */
  logger?: Logger;
}

export const createRedisBridge = (
  config: Config,
  opts: CreateRedisBridgeOpts = {},
): RedisBridge => {
  const { client: injected, logger } = opts;

  const redis =
    injected ??
    new Redis(config.REDIS_URL, {
      // Long-lived sidecar — let ioredis keep retrying instead of bouncing requests.
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      // Don't auto-connect at construction; bootstrap.ts orders start() explicitly.
      lazyConnect: true,
      retryStrategy,
    });

  if (!injected && logger) {
    wireLifecycleEvents(redis, logger, 'redis');
  }

  return {
    async start() {
      // ioredis: status === 'wait' (lazy) or 'connecting'/'connect'/'reconnecting' here.
      // connect() resolves when 'ready' is emitted (or rejects on failure).
      if (redis.status !== 'ready') await redis.connect();
    },

    async assertQueueDurable() {
      let policy: string | null = null;
      try {
        policy = readPolicyReply(await redis.config('GET', 'maxmemory-policy'));
      } catch {
        policy = null;
      }

      if (policy === 'noeviction') return;

      queueDurabilityViolationsTotal.inc({ policy: policy ?? UNDETERMINABLE });

      const detail =
        policy === null
          ? `the queue Redis maxmemory-policy could not be determined (CONFIG GET unavailable or unexpected reply)`
          : `the queue Redis reports maxmemory-policy='${policy}', not 'noeviction'`;

      const message =
        `csms-mqtt-bridge — ${detail}. Under memory pressure the queue can be evicted ` +
        `AFTER the bridge has already PUBACK'd the message to the broker, so it is lost ` +
        `on both sides with no error and no redelivery. Point REDIS_URL at the dedicated ` +
        `noeviction instance (docker-compose redis-queue) — the same instance the ` +
        `csms-server worker's REDIS_MQTT_* must resolve to. Set ` +
        `REDIS_REQUIRE_NOEVICTION=false to downgrade this to a warning.`;

      if (config.REDIS_REQUIRE_NOEVICTION) {
        throw new Error(message);
      }

      logger?.warn(
        { policy: policy ?? UNDETERMINABLE, redisRequireNoeviction: false },
        `[QUEUE_DURABILITY] ${message}`,
      );
    },

    async pushIncoming(envelope) {
      await redis.lpush(config.REDIS_QUEUE_INCOMING, JSON.stringify(envelope));
    },

    async quit() {
      // ioredis quit() throws if connection is already closed; tolerate that.
      try {
        await redis.quit();
      } catch {
        // ignore
      }
    },

    isReady() {
      return redis.status === 'ready';
    },
  };
};

// Exported for unit tests.
export const __test__ = { retryStrategy, readPolicyReply };
