/**
 * Integration proof for the one bridge failure mode that loses data.
 *
 * Everything else in this suite runs against doubles. This file does not: it needs
 * a real Redis, because the defect it pins is invisible to a mock. Under an
 * eviction policy `LPUSH` reports SUCCESS and Redis discards the entry anyway —
 * there is no error for a fake client to reproduce. The only way to observe it is
 * to fill a real Redis and compare what was acknowledged against what survived.
 *
 * The invariant, in the words that matter: a message must be either DELIVERED or
 * UNACKNOWLEDGED. Never acknowledged and gone.
 *
 * Set REDIS_INTEGRATION_URL to run. CI provides one (see .github/workflows/ci.yml);
 * `integration suite must not be silently skipped in CI` below fails the build if
 * that ever stops being true, so this cannot decay into a test that runs nowhere.
 */
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../config.js';
import { createRedisBridge } from '../redis.js';

const url = process.env['REDIS_INTEGRATION_URL'];

// Big enough that a few hundred fit in the tiny maxmemory below.
const PAYLOAD = 'x'.repeat(50_000);
const PUSHES = 400;
const MAXMEMORY = '3mb';

const key = (suffix: string): string => `csms-bridge-itest:${suffix}`;

const cfgFor = (k: string): Config =>
  ({
    REDIS_URL: url,
    REDIS_QUEUE_INCOMING: k,
    REDIS_QUEUE_OUTGOING: key('out'),
    REDIS_QUEUE_PROCESSING: key('proc'),
    REDIS_BLPOP_TIMEOUT_SEC: 1,
    REDIS_REQUIRE_NOEVICTION: true,
  }) as unknown as Config;

const envelope = (i: number): Parameters<ReturnType<typeof createRedisBridge>['pushIncoming']>[0] => ({
  version: 1,
  topic: 'ospp/v1/stations/stn_00000001/to-server',
  stationId: 'stn_00000001',
  payload: PAYLOAD,
  qos: 1,
  receivedAt: new Date(0).toISOString(),
  messageId: `itest-${i.toString()}`,
  properties: null,
});

/** Pushes until memory is exhausted; reports what was acked vs what survived. */
const fillAndMeasure = async (
  bridge: ReturnType<typeof createRedisBridge>,
  admin: Redis,
  k: string,
): Promise<{ acked: number; rejected: number; surviving: number }> => {
  let acked = 0;
  let rejected = 0;
  for (let i = 0; i < PUSHES; i++) {
    try {
      await bridge.pushIncoming(envelope(i));
      acked++;
    } catch {
      rejected++;
    }
  }
  const surviving = await admin.llen(k);
  return { acked, rejected, surviving };
};

it('integration suite must not be silently skipped in CI', () => {
  if (process.env['CI'] === 'true') {
    expect(
      url,
      'REDIS_INTEGRATION_URL is unset in CI — the eviction proof would not have run',
    ).toBeTruthy();
  }
});

describe.skipIf(!url)('eviction — a message is DELIVERED or UNACKED, never acked-and-gone', () => {
  let admin: Redis;
  let originalPolicy: string;
  let originalMaxmemory: string;

  const readConfig = async (param: string): Promise<string> => {
    const reply = (await admin.config('GET', param)) as string[];
    return reply[1] ?? '';
  };

  beforeAll(async () => {
    const { Redis: Ctor } = await import('ioredis');
    // describe.skipIf guarantees url is set whenever this runs.
    admin = new Ctor(url ?? '');
    originalPolicy = await readConfig('maxmemory-policy');
    originalMaxmemory = await readConfig('maxmemory');
  });

  afterAll(async () => {
    await admin.config('SET', 'maxmemory', originalMaxmemory || '0');
    await admin.config('SET', 'maxmemory-policy', originalPolicy || 'noeviction');
    const keys = await admin.keys('csms-bridge-itest:*');
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  it('under noeviction: everything acked survived, and the overflow was REFUSED', async () => {
    const k = key('noevict');
    await admin.del(k);
    await admin.config('SET', 'maxmemory', '0');
    await admin.config('SET', 'maxmemory-policy', 'noeviction');
    await admin.config('SET', 'maxmemory', MAXMEMORY);

    const bridge = createRedisBridge(cfgFor(k));
    await bridge.start();
    const { acked, rejected, surviving } = await fillAndMeasure(bridge, admin, k);
    await bridge.quit();
    await admin.config('SET', 'maxmemory', '0');

    // Anti-vacuity: if memory was never exhausted the comparison below is trivially
    // true and proves nothing. Refuse to pass without real pressure.
    expect(rejected, 'memory was never exhausted — the test proved nothing').toBeGreaterThan(0);

    // The invariant. Under noeviction the overflow is refused, the bridge withholds
    // the PUBACK, and the broker keeps the message.
    expect(acked).toBe(surviving);
  });

  // The discriminating direction. This asserts the loss is REAL under the wrong
  // policy — which is what makes the assertion above meaningful rather than
  // decorative, and what assertQueueDurable() exists to prevent ever reaching.
  it('under allkeys-lru the SAME code loses acked messages — which is why the guard refuses it', async () => {
    const k = key('lru');
    await admin.del(k);
    await admin.config('SET', 'maxmemory', '0');
    await admin.config('SET', 'maxmemory-policy', 'allkeys-lru');
    await admin.config('SET', 'maxmemory', MAXMEMORY);

    const bridge = createRedisBridge(cfgFor(k));
    await bridge.start();
    const { acked, rejected, surviving } = await fillAndMeasure(bridge, admin, k);

    // Nothing is refused: every push "succeeds" and the bridge would PUBACK each one.
    expect(rejected).toBe(0);
    expect(acked).toBe(PUSHES);
    // …yet messages are gone. This is the silent loss, reproduced.
    expect(surviving).toBeLessThan(acked);

    // And this is the guard that stops the bridge from ever running here.
    await expect(bridge.assertQueueDurable()).rejects.toThrow(/allkeys-lru/);
    await bridge.quit();
    await admin.config('SET', 'maxmemory', '0');
  });

  it('under noeviction the guard passes', async () => {
    await admin.config('SET', 'maxmemory-policy', 'noeviction');
    const bridge = createRedisBridge(cfgFor(key('guard')));
    await bridge.start();
    await expect(bridge.assertQueueDurable()).resolves.toBeUndefined();
    await bridge.quit();
  });
});
