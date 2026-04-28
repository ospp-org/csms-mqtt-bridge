import pino from 'pino';

import type { Config } from './config.js';
import { ConfigError, loadConfig, sanitizedConfigForLog } from './config.js';

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
  { phase: '0.3', config: sanitizedConfigForLog(config) },
  'csms-mqtt-bridge starting (Phase 0.3 — config validated; MQTT client wires up in 0.4)',
);

// Keep the event loop alive so SIGTERM can be observed; replaced by the MQTT
// client connection in Phase 0.4.
const keepAlive = setInterval(() => {
  // no-op heartbeat
}, 60_000);

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, 'shutdown');
  clearInterval(keepAlive);
  process.exit(0);
};

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
