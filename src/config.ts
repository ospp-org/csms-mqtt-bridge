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
  MQTT_CA_PATH: readableFile('MQTT_CA_PATH'),
  REDIS_URL: urlWithProtocol(['redis:', 'rediss:'], 'redis://host:6379'),

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
  REDIS_QUEUE_INCOMING: z.string().min(1).default('mqtt:incoming'),
  REDIS_QUEUE_OUTGOING: z.string().min(1).default('mqtt:outgoing'),
  // Bridge-internal queue holding messages BLMOVE'd out of OUTGOING and not yet
  // acked (PUBACK from broker). On startup the bridge replays anything stuck
  // here from a previous crash. Single-instance scope; multi-instance HA
  // (Phase F.7) will need a per-clientId suffix to avoid cross-instance theft.
  REDIS_QUEUE_PROCESSING: z.string().min(1).default('mqtt:processing'),
  REDIS_BLPOP_TIMEOUT_SEC: positiveInt.default(5),
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
  caPath: config.MQTT_CA_PATH,
  rejectUnauthorized: config.MQTT_REJECT_UNAUTHORIZED,
  redisUrl: redactUrl(config.REDIS_URL),
  redisQueueIncoming: config.REDIS_QUEUE_INCOMING,
  redisQueueOutgoing: config.REDIS_QUEUE_OUTGOING,
  redisQueueProcessing: config.REDIS_QUEUE_PROCESSING,
  metricsPort: config.METRICS_PORT,
  logLevel: config.LOG_LEVEL,
  shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
  mqttKeepalive: config.MQTT_KEEPALIVE,
  mqttReconnectPeriod: config.MQTT_RECONNECT_PERIOD,
  mqttConnectTimeout: config.MQTT_CONNECT_TIMEOUT,
  ...(config.MQTT_SERVERNAME === undefined ? {} : { servername: config.MQTT_SERVERNAME }),
});
