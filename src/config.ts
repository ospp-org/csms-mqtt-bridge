import { accessSync, constants } from 'node:fs';
import { z } from 'zod';

const truthy = ['true', '1', 'yes'] as const;
const falsy = ['false', '0', 'no'] as const;

const booleanFromEnv = z.string().transform((value, ctx) => {
  const lower = value.toLowerCase();
  if (truthy.includes(lower as (typeof truthy)[number])) return true;
  if (falsy.includes(lower as (typeof falsy)[number])) return false;
  ctx.addIssue({
    code: 'custom',
    message: `expected one of ${[...truthy, ...falsy].join('|')}, got '${value}'`,
  });
  return z.NEVER;
});

const readableFile = (label: string) =>
  z
    .string()
    .min(1, { message: `${label}: must be a non-empty path` })
    .superRefine((path, ctx) => {
      try {
        accessSync(path, constants.R_OK);
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: `${label}: file not found or not readable: ${path}`,
        });
      }
    });

const positiveInt = z.coerce
  .number({ message: 'must be a number' })
  .int({ message: 'must be an integer' })
  .nonnegative({ message: 'must be ≥ 0' });

// A watchdog limit. Floored at one second: a smaller value would end a bridge that is
// merely between two messages or two reconnect attempts.
const watchdogLimitMs = z.coerce
  .number({ message: 'must be a number' })
  .int({ message: 'must be an integer' })
  .min(1000, { message: 'must be >= 1000 (ms)' });

const port = z.coerce
  .number({ message: 'must be a number' })
  .int({ message: 'must be an integer' })
  .min(1, { message: 'must be ≥ 1' })
  .max(65535, { message: 'must be ≤ 65535' });

const urlWithProtocol = (allowedProtocols: readonly string[], example: string) =>
  z.url({ message: `must be a valid URL (e.g. ${example})` }).refine(
    (raw) => {
      try {
        return allowedProtocols.includes(new URL(raw).protocol);
      } catch {
        return false;
      }
    },
    { message: `must use one of: ${allowedProtocols.join(', ')}` },
  );

const envSchema = z.object({
  // Required
  MQTT_BROKER_URL: urlWithProtocol(['mqtt:', 'mqtts:'], 'mqtts://host:8884'),
  MQTT_CLIENT_ID: z.string().min(1, { message: 'must be a non-empty string' }),
  MQTT_CERT_PATH: readableFile('MQTT_CERT_PATH'),
  MQTT_KEY_PATH: readableFile('MQTT_KEY_PATH'),
  REDIS_URL: urlWithProtocol(['redis:', 'rediss:'], 'redis://host:6379'),

  // Optional. When set, the file is read and used as the TLS trust anchor.
  // When unset, mqtt.js / tls.connect fall back to Node's default trust
  // (system CA bundle, includes Let's Encrypt and other public roots) — the
  // right choice when the broker presents a publicly-trusted certificate.
  // Required only for non-public CAs (self-signed, internal Station CA).
  MQTT_CA_PATH: readableFile('MQTT_CA_PATH').optional(),

  // Optional, no default. When set, passed to mqtt.js as `servername` so the
  // TLS handshake sends this hostname in SNI. Useful when the connect URL host
  // differs from the broker certificate's SAN — e.g. connecting to a Docker
  // network alias (`emqx`) while the broker cert covers public hostnames
  // (`mqtt-uat.onestoppay.ro`). When unset, mqtt.js defaults SNI to the URL
  // host (current behavior).
  MQTT_SERVERNAME: z.string().min(1, { message: 'must be a non-empty string' }).optional(),

  // Optional with defaults
  MQTT_REJECT_UNAUTHORIZED: booleanFromEnv.default(true),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  METRICS_PORT: port.default(9090),
  SHUTDOWN_TIMEOUT_MS: positiveInt.default(10000),
  MQTT_KEEPALIVE: positiveInt.default(60),
  MQTT_RECONNECT_PERIOD: positiveInt.default(5000),
  MQTT_CONNECT_TIMEOUT: positiveInt.default(30000),
  // MQTT 5 Session Expiry Interval (seconds), advertised in CONNECT. Paired with
  // clean:false it keeps the session — its PLAIN subscription and any QoS-1 messages
  // the broker queues for it — alive across a brief bridge disconnect (AUDIT-05 F-02;
  // see STATION_INBOUND_TOPIC in mqtt.ts for why the subscription is plain, not $share/).
  // The spec value is 3600 (02-transport.md, section 1.2 Connection Parameters). positiveInt
  // EXCLUDES 0 on purpose: a zero expiry IS part of the bug (session deleted on disconnect →
  // station QoS-1 messages dropped mid-partition), so it can never be reintroduced by config.
  MQTT_SESSION_EXPIRY_INTERVAL: positiveInt.default(3600),
  REDIS_QUEUE_INCOMING: z.string().min(1).default('mqtt:incoming'),
  // Refuse to start when the queue Redis can EVICT the queue out from under us.
  // Default true, and deliberately so: under an eviction policy an LPUSH reports
  // success, the bridge PUBACKs, the broker drops its copy, and Redis silently
  // discards the entry — the message is lost on both sides with no error, no log
  // and no metric. Measured against a real Redis: `allkeys-lru` 400 pushes ->
  // 400 resolved / 0 rejected / 16 surviving; `noeviction` -> resolved ==
  // surviving exactly, the overflow rejected with OOM so the ack is withheld.
  // Set false ONLY for a local stack you accept losing messages on; it downgrades
  // the refusal to a warning and a counter, it does not make the loss safe.
  // Mirrors csms-server MqttConsume::assertQueueRedisDurable() on the reader side.
  REDIS_REQUIRE_NOEVICTION: booleanFromEnv.default(true),

  // Watchdog (src/watchdog.ts): how long each stuck condition is tolerated before the
  // bridge exits non-zero, so the container's restart policy restarts it. A restart
  // loses nothing - the session is persistent and nothing stuck was acknowledged.
  // The broker connection down (a broker never reached since start counts); 120 s rides
  // out a broker restart (tens of seconds) without a bridge restart.
  WATCHDOG_MQTT_DOWN_MS: watchdogLimitMs.default(120_000),
  // One inbound message in hand (its Redis push unsettled), or one left unacknowledged
  // waiting for a new connection.
  WATCHDOG_INBOUND_STALL_MS: watchdogLimitMs.default(60_000),
});

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  public override readonly name = 'ConfigError';
  public readonly issues: readonly z.core.$ZodIssue[];

  constructor(issues: readonly z.core.$ZodIssue[]) {
    const lines = issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `  ${path}: ${issue.message}`;
    });
    super(
      `Configuration error (${issues.length.toString()} issue${issues.length === 1 ? '' : 's'}):\n${lines.join('\n')}`,
    );
    this.issues = issues;
  }
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }
  return result.data;
};

const REDIS_URL_REDACT = /:\/\/[^@/]+@/;

/** Redacts user:password from a URL for safe logging. */
export const redactUrl = (url: string): string => url.replace(REDIS_URL_REDACT, '://***@');

/** Returns a config snapshot safe to log (omits private-key path, redacts URL credentials). */
export const sanitizedConfigForLog = (
  config: Config,
): Record<string, string | number | boolean> => ({
  brokerUrl: redactUrl(config.MQTT_BROKER_URL),
  clientId: config.MQTT_CLIENT_ID,
  certPath: config.MQTT_CERT_PATH,
  rejectUnauthorized: config.MQTT_REJECT_UNAUTHORIZED,
  redisUrl: redactUrl(config.REDIS_URL),
  redisQueueIncoming: config.REDIS_QUEUE_INCOMING,
  redisRequireNoeviction: config.REDIS_REQUIRE_NOEVICTION,
  metricsPort: config.METRICS_PORT,
  logLevel: config.LOG_LEVEL,
  shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  mqttKeepalive: config.MQTT_KEEPALIVE,
  mqttReconnectPeriod: config.MQTT_RECONNECT_PERIOD,
  mqttConnectTimeout: config.MQTT_CONNECT_TIMEOUT,
  mqttSessionExpiryInterval: config.MQTT_SESSION_EXPIRY_INTERVAL,
  watchdogMqttDownMs: config.WATCHDOG_MQTT_DOWN_MS,
  watchdogInboundStallMs: config.WATCHDOG_INBOUND_STALL_MS,
  ...(config.MQTT_CA_PATH === undefined ? {} : { caPath: config.MQTT_CA_PATH }),
  ...(config.MQTT_SERVERNAME === undefined ? {} : { servername: config.MQTT_SERVERNAME }),
});
