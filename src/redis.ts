import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { Config } from './config.js';
import { state } from './state.js';

export type Qos = 0 | 1 | 2;

/**
 * Schema version for envelopes flowing across the bridge ↔ csms-server
 * Redis-queue boundary. Incompatible schema changes MUST bump this; consumers
 * reject unknown versions cleanly (see parseOutgoingEnvelope below). The
 * authoritative contract is documented in docs/REDIS-QUEUE-CONTRACT.md.
 */
export const ENVELOPE_VERSION = 1 as const;
export type EnvelopeVersion = typeof ENVELOPE_VERSION;

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

export interface OutgoingEnvelope {
  version: EnvelopeVersion;
  topic: string;
  payload: string;
  qos: Qos;
  properties?: Record<string, unknown>;
}

/**
 * One outbound message reserved for processing. The bridge calls `ack()` after
 * the broker confirms PUBACK; until then the raw JSON stays in the processing
 * list and will be replayed on next bridge startup if the bridge crashes.
 */
export interface ReliableOutgoing {
  envelope: OutgoingEnvelope;
  /** Raw JSON string, used as the LREM target for an exact-match removal. */
  raw: string;
  ack(): Promise<void>;
}

export interface RedisBridge {
  /**
   * Connect (lazyConnect) and wait until the client is ready. Idempotent: a
   * second call after ready resolves immediately.
   */
  start(): Promise<void>;
  pushIncoming(envelope: IncomingEnvelope): Promise<void>;
  /**
   * Atomically move one envelope from the OUTGOING list to the PROCESSING
   * list (BLMOVE) and return it with an `ack()` closure. Returns null on the
   * BLMOVE timeout (no message available within REDIS_BLPOP_TIMEOUT_SEC).
   * Throws if a moved item fails to parse — in that case the malformed raw
   * string is removed from PROCESSING (we don't replay garbage forever).
   */
  popOutgoingReliable(): Promise<ReliableOutgoing | null>;
  /**
   * Read every item currently in the PROCESSING list (without consuming) and
   * return parsed envelopes with their `ack()` closures. Used at startup to
   * recover from a previous crash. Items that fail to parse are removed and
   * logged.
   */
  replayProcessing(): Promise<ReliableOutgoing[]>;
  quit(): Promise<void>;
  isReady(): boolean;
}

const isQos = (value: unknown): value is Qos => value === 0 || value === 1 || value === 2;

const parseOutgoingEnvelope = (raw: string): OutgoingEnvelope => {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('outgoing envelope is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] === undefined) {
    throw new Error(
      `outgoing envelope missing "version" field; expected ${ENVELOPE_VERSION.toString()}`,
    );
  }
  if (obj['version'] !== ENVELOPE_VERSION) {
    throw new Error(
      `outgoing envelope version mismatch: got ${JSON.stringify(obj['version'])}, expected ${ENVELOPE_VERSION.toString()}`,
    );
  }
  if (typeof obj['topic'] !== 'string' || obj['topic'].length === 0) {
    throw new Error('outgoing envelope missing string "topic"');
  }
  if (typeof obj['payload'] !== 'string') {
    throw new Error('outgoing envelope missing string "payload" (base64)');
  }
  if (!isQos(obj['qos'])) {
    throw new Error('outgoing envelope "qos" must be 0, 1, or 2');
  }
  const envelope: OutgoingEnvelope = {
    version: ENVELOPE_VERSION,
    topic: obj['topic'],
    payload: obj['payload'],
    qos: obj['qos'],
  };
  if (obj['properties'] !== undefined) {
    if (typeof obj['properties'] !== 'object' || obj['properties'] === null) {
      throw new Error('outgoing envelope "properties" must be an object');
    }
    envelope.properties = obj['properties'] as Record<string, unknown>;
  }
  return envelope;
};

/** Exponential backoff capped at 30s, with mild jitter to avoid thundering herd. */
const retryStrategy = (times: number): number => {
  const base = Math.min(30_000, 100 * Math.pow(2, times - 1));
  const jitter = Math.floor(Math.random() * 200);
  return base + jitter;
};

const wireLifecycleEvents = (redis: Redis, logger: Logger): void => {
  redis.on('connect', () => {
    logger.debug('redis socket connected');
  });
  redis.on('ready', () => {
    state.redisConnected = true;
    logger.info('redis ready');
  });
  redis.on('reconnecting', (delayMs: number) => {
    logger.warn({ delayMs }, 'redis reconnecting');
  });
  redis.on('error', (err: Error) => {
    logger.error({ err }, 'redis client error');
  });
  redis.on('close', () => {
    state.redisConnected = false;
    logger.warn('redis connection closed');
  });
  redis.on('end', () => {
    state.redisConnected = false;
    logger.warn('redis connection ended');
  });
};

export interface CreateRedisBridgeOpts {
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
      // Don't auto-connect at construction; index.ts orders start() explicitly.
      lazyConnect: true,
      retryStrategy,
    });

  if (!injected && logger) {
    wireLifecycleEvents(redis, logger);
  }

  const ackOf = (raw: string) => async (): Promise<void> => {
    await redis.lrem(config.REDIS_QUEUE_PROCESSING, 1, raw);
  };

  return {
    async start() {
      if (redis.status === 'ready') return;
      // ioredis: status === 'wait' (lazy) or 'connecting'/'connect'/'reconnecting' here.
      // connect() resolves when 'ready' is emitted (or rejects on failure).
      await redis.connect();
    },

    async pushIncoming(envelope) {
      await redis.lpush(config.REDIS_QUEUE_INCOMING, JSON.stringify(envelope));
    },

    async popOutgoingReliable() {
      const raw = await redis.blmove(
        config.REDIS_QUEUE_OUTGOING,
        config.REDIS_QUEUE_PROCESSING,
        'LEFT',
        'RIGHT',
        config.REDIS_BLPOP_TIMEOUT_SEC,
      );
      if (raw === null) return null;

      let envelope: OutgoingEnvelope;
      try {
        envelope = parseOutgoingEnvelope(raw);
      } catch (err) {
        // Malformed envelope — drop from PROCESSING so the loop doesn't replay
        // it forever, and re-throw so the caller can log and continue.
        await redis.lrem(config.REDIS_QUEUE_PROCESSING, 1, raw);
        throw err;
      }

      return { envelope, raw, ack: ackOf(raw) };
    },

    async replayProcessing() {
      const items = await redis.lrange(config.REDIS_QUEUE_PROCESSING, 0, -1);
      const out: ReliableOutgoing[] = [];
      for (const raw of items) {
        try {
          const envelope = parseOutgoingEnvelope(raw);
          out.push({ envelope, raw, ack: ackOf(raw) });
        } catch (err) {
          // Malformed leftover from a previous crash — drop and continue.
          if (logger) {
            logger.error(
              { err, raw: raw.slice(0, 200) },
              'malformed envelope in processing queue, dropping',
            );
          }
          await redis.lrem(config.REDIS_QUEUE_PROCESSING, 1, raw);
        }
      }
      return out;
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
export const __test__ = { parseOutgoingEnvelope, retryStrategy };
