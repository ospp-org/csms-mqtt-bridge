import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pino from 'pino';

import { bootstrap } from './bootstrap.js';
import type { Config } from './config.js';
import { ConfigError, loadConfig, sanitizedConfigForLog } from './config.js';
import { buildHealthReport, healthStatusCode } from './health.js';
import { register as metricsRegister, setBuildInfo } from './metrics.js';
import type { MqttBridge } from './mqtt.js';
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

setBuildInfo(pkg.version);

logger.info(
  { version: pkg.version, config: sanitizedConfigForLog(config) },
  'csms-mqtt-bridge starting',
);

// Ordered startup — see bootstrap.ts for why the order is load-bearing. The
// MQTT client is constructed ONLY after Redis is ready AND proven non-evicting,
// because the client acks to the broker the moment a push resolves.
const redis: RedisBridge = createRedisBridge(config, { logger });

let mqtt: MqttBridge | null = null;

void (async (): Promise<void> => {
  try {
    mqtt = await bootstrap({
      redis,
      startMqtt: () => startMqttClient(config, redis, logger),
      logger,
    });
  } catch (err) {
    logger.fatal({ err }, 'bridge failed to start, exiting');
    process.exit(1);
  }
})();

const metricsServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';
  if (url === '/metrics' || url.startsWith('/metrics?')) {
    void metricsRegister
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'Content-Type': metricsRegister.contentType });
        res.end(body);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'metrics endpoint failed to render');
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('metrics render failed');
      });
    return;
  }
  if (url === '/healthz') {
    // Answers the two questions that decide whether this process is doing its job:
    // attached to the broker, and able to write the queue. It used to return 200
    // unconditionally, which made a totally wedged bridge indistinguishable from a
    // working one to every layer that asked.
    const report = buildHealthReport({ redis });
    const code = healthStatusCode(report);
    if (code !== 200) {
      logger.warn({ health: report }, 'health probe reporting unhealthy');
    }
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(report));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});
metricsServer.listen(config.METRICS_PORT, () => {
  logger.info(
    { port: config.METRICS_PORT, endpoints: ['/metrics', '/healthz'] },
    'metrics http server listening',
  );
});

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
      // null when startup never completed (Redis down, or the durability guard
      // refused) — there is no broker connection to drain in that case.
      await mqtt?.stop();
      await redis.quit();
      await new Promise<void>((resolve) => {
        metricsServer.close(() => {
          resolve();
        });
      });
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
