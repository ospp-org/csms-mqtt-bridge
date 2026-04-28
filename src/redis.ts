import { Redis } from 'ioredis';

import type { Config } from './config.js';

export type Qos = 0 | 1 | 2;

export interface IncomingEnvelope {
  topic: string;
  stationId: string;
  payload: string;
  qos: Qos;
  receivedAt: string;
  messageId: string;
  properties: Record<string, unknown> | null;
}

export interface OutgoingEnvelope {
  topic: string;
  payload: string;
  qos: Qos;
  properties?: Record<string, unknown>;
}

export interface RedisBridge {
  pushIncoming(envelope: IncomingEnvelope): Promise<void>;
  popOutgoing(): Promise<OutgoingEnvelope | null>;
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

export const createRedisBridge = (config: Config, client?: Redis): RedisBridge => {
  const redis =
    client ??
    new Redis(config.REDIS_URL, {
      // Long-lived sidecar — let ioredis keep retrying instead of bouncing requests.
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

  return {
    async pushIncoming(envelope) {
      await redis.lpush(config.REDIS_QUEUE_INCOMING, JSON.stringify(envelope));
    },
    async popOutgoing() {
      const result = await redis.blpop(config.REDIS_QUEUE_OUTGOING, config.REDIS_BLPOP_TIMEOUT_SEC);
      if (!result) return null;
      const [, raw] = result;
      return parseOutgoingEnvelope(raw);
    },
    async quit() {
      await redis.quit();
    },
    isReady() {
      return redis.status === 'ready';
    },
  };
};

// Exported for unit tests.
export const __test__ = { parseOutgoingEnvelope };
