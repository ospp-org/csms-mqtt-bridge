import pino from 'pino';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'csms-mqtt-bridge' },
});

logger.info(
  { phase: '0.2', status: 'placeholder' },
  'csms-mqtt-bridge starting (placeholder, Phase 0.3 not implemented yet)',
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
