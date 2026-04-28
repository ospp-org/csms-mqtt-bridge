import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pino from 'pino';

import type { Config } from './config.js';
import { ConfigError, loadConfig, sanitizedConfigForLog } from './config.js';
import { startMqttClient } from './mqtt.js';
import type { RedisBridge } from './redis.js';
import { createRedisBridge } from './redis.js';

// Resolve package.json relative to the compiled entrypoint so the same path
// works for `node dist/index.js` (dist/../package.json) and `tsx src/index.ts`
// (src/../package.json). Read once at module load — package.json is part of
// the deployed artifact; if it's missing, we fail to start, which is correct.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

const loadConfigOrExit = (): Config => {
  try {
    return loadConfig();
  } catch (err) {
    // Bootstrap logger — no config-driven level yet; log fatal to stderr and exit.
    const bootstrapLogger = pino({ level: 'fatal', base: { service: 'csms-mqtt-bridge' } });
    if (err instanceof ConfigError) {
      bootstrapLogger.fatal({ issues: err.issues }, err.message);
    } else {
      bootstrapLogger.fatal({ err }, 'unexpected error during config load');
    }
    process.exit(1);
  }
};

const config = loadConfigOrExit();

const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'csms-mqtt-bridge' },
});

if (!config.MQTT_REJECT_UNAUTHORIZED) {
  logger.warn(
    { mqttRejectUnauthorized: false },
    'INSECURE: TLS server cert validation disabled (MQTT_REJECT_UNAUTHORIZED=false). Do not use in production.',
  );
}

logger.info(
  { version: pkg.version, config: sanitizedConfigForLog(config) },
  'csms-mqtt-bridge starting',
);

// Ordered startup:
//  1. Build the Redis bridge first (lazyConnect) — both MQTT inbound (push to
//     incoming) and outbound (BLMOVE from outgoing) need Redis to be ready.
//  2. redis.start() opens the connection and resolves on 'ready'. If Redis is
//     unreachable, this rejects and we exit fatal.
//  3. Once Redis is up, start the MQTT client. Its 'connect' handler triggers
//     the processing-queue replay, which Redis MUST be ready to serve.
const redis: RedisBridge = createRedisBridge(config, { logger });

void (async (): Promise<void> => {
  try {
    await redis.start();
  } catch (err) {
    logger.fatal({ err }, 'redis failed to start, exiting');
    process.exit(1);
  }
})();

const mqtt = startMqttClient(config, redis, logger);

// Reverse of startup: stop MQTT (drains outbound, publishes offline, ends),
// then quit Redis. Bounded by SHUTDOWN_TIMEOUT_MS so a wedged peer can't
// keep the process alive past its grace period.
let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) {
    logger.warn({ signal }, 'shutdown already in progress, ignoring duplicate signal');
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutdown initiated');

  const deadline = setTimeout(() => {
    logger.error(
      { timeoutMs: config.SHUTDOWN_TIMEOUT_MS },
      'shutdown deadline exceeded, forcing exit',
    );
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  void (async (): Promise<void> => {
    try {
      await mqtt.stop();
      await redis.quit();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  })();
};

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
