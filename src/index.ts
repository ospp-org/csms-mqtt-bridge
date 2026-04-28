import pino from 'pino';

import type { Config } from './config.js';
import { ConfigError, loadConfig, sanitizedConfigForLog } from './config.js';
import { startMqttClient } from './mqtt.js';
import type { RedisBridge } from './redis.js';
import { createRedisBridge } from './redis.js';

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

logger.info({ phase: '0.4', config: sanitizedConfigForLog(config) }, 'csms-mqtt-bridge starting');

const redis: RedisBridge = createRedisBridge(config);
const mqtt = startMqttClient(config, redis, logger);

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
