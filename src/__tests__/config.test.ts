import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, redactUrl, sanitizedConfigForLog } from '../config.js';

let tmpDir: string;
let validEnv: Record<string, string>;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `csms-mqtt-bridge-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'cert.pem'), 'fake');
  writeFileSync(join(tmpDir, 'key.pem'), 'fake');
  writeFileSync(join(tmpDir, 'ca.pem'), 'fake');

  validEnv = {
    MQTT_BROKER_URL: 'mqtts://broker.test:8884',
    MQTT_CLIENT_ID: 'csms-test-server-1',
    MQTT_CERT_PATH: join(tmpDir, 'cert.pem'),
    MQTT_KEY_PATH: join(tmpDir, 'key.pem'),
    MQTT_CA_PATH: join(tmpDir, 'ca.pem'),
    REDIS_URL: 'redis://redis.test:6379',
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadConfig — happy paths', () => {
  it('returns typed config when all required env vars are set', () => {
    const cfg = loadConfig(validEnv);

    expect(cfg.MQTT_BROKER_URL).toBe('mqtts://broker.test:8884');
    expect(cfg.MQTT_CLIENT_ID).toBe('csms-test-server-1');
    expect(cfg.REDIS_URL).toBe('redis://redis.test:6379');
  });

  it('applies defaults for all optional vars', () => {
    const cfg = loadConfig(validEnv);

    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.METRICS_PORT).toBe(9090);
    expect(cfg.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(cfg.MQTT_KEEPALIVE).toBe(60);
    expect(cfg.MQTT_RECONNECT_PERIOD).toBe(5_000);
    expect(cfg.MQTT_CONNECT_TIMEOUT).toBe(30_000);
    expect(cfg.MQTT_REJECT_UNAUTHORIZED).toBe(true);
    expect(cfg.REDIS_QUEUE_INCOMING).toBe('mqtt:incoming');
    expect(cfg.REDIS_QUEUE_OUTGOING).toBe('mqtt:outgoing');
    expect(cfg.REDIS_BLPOP_TIMEOUT_SEC).toBe(5);
  });

  it('coerces numeric vars to numbers', () => {
    const cfg = loadConfig({
      ...validEnv,
      METRICS_PORT: '8080',
      SHUTDOWN_TIMEOUT_MS: '7500',
    });

    expect(cfg.METRICS_PORT).toBe(8080);
    expect(typeof cfg.METRICS_PORT).toBe('number');
    expect(cfg.SHUTDOWN_TIMEOUT_MS).toBe(7500);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['TRUE', true],
    ['Yes', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['NO', false],
  ])('parses MQTT_REJECT_UNAUTHORIZED=%s as %s', (input, expected) => {
    const cfg = loadConfig({ ...validEnv, MQTT_REJECT_UNAUTHORIZED: input });
    expect(cfg.MQTT_REJECT_UNAUTHORIZED).toBe(expected);
  });

  it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])(
    'accepts valid LOG_LEVEL=%s',
    (level) => {
      const cfg = loadConfig({ ...validEnv, LOG_LEVEL: level });
      expect(cfg.LOG_LEVEL).toBe(level);
    },
  );
});

describe('loadConfig — failure paths', () => {
  it('throws ConfigError when a required var is missing', () => {
    const { MQTT_CLIENT_ID: _omit, ...incomplete } = validEnv;
    expect(() => loadConfig(incomplete)).toThrow(ConfigError);
    expect(() => loadConfig(incomplete)).toThrow(/MQTT_CLIENT_ID/);
  });

  it('lists every missing required var in a single error', () => {
    let captured: ConfigError | undefined;
    try {
      loadConfig({});
    } catch (err) {
      if (err instanceof ConfigError) captured = err;
    }

    expect(captured).toBeInstanceOf(ConfigError);
    const paths = captured?.issues.map((i) => i.path[0]) ?? [];
    expect(paths).toContain('MQTT_BROKER_URL');
    expect(paths).toContain('MQTT_CLIENT_ID');
    expect(paths).toContain('MQTT_CERT_PATH');
    expect(paths).toContain('MQTT_KEY_PATH');
    expect(paths).toContain('MQTT_CA_PATH');
    expect(paths).toContain('REDIS_URL');
  });

  it('throws on invalid MQTT_BROKER_URL', () => {
    expect(() => loadConfig({ ...validEnv, MQTT_BROKER_URL: 'not-a-url' })).toThrow(
      /MQTT_BROKER_URL/,
    );
  });

  it('throws on invalid REDIS_URL', () => {
    expect(() => loadConfig({ ...validEnv, REDIS_URL: 'plain-string' })).toThrow(/REDIS_URL/);
  });

  it('throws on non-numeric METRICS_PORT', () => {
    expect(() => loadConfig({ ...validEnv, METRICS_PORT: 'abc' })).toThrow(/METRICS_PORT/);
  });

  it('throws on out-of-range METRICS_PORT', () => {
    expect(() => loadConfig({ ...validEnv, METRICS_PORT: '70000' })).toThrow(/METRICS_PORT/);
    expect(() => loadConfig({ ...validEnv, METRICS_PORT: '0' })).toThrow(/METRICS_PORT/);
  });

  it('throws on invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('throws on invalid boolean for MQTT_REJECT_UNAUTHORIZED', () => {
    expect(() => loadConfig({ ...validEnv, MQTT_REJECT_UNAUTHORIZED: 'maybe' })).toThrow(
      /MQTT_REJECT_UNAUTHORIZED/,
    );
  });

  it('throws when MQTT_CERT_PATH does not exist', () => {
    expect(() => loadConfig({ ...validEnv, MQTT_CERT_PATH: '/does/not/exist/cert.pem' })).toThrow(
      /MQTT_CERT_PATH.*not found or not readable/,
    );
  });

  it('throws when MQTT_KEY_PATH does not exist', () => {
    expect(() => loadConfig({ ...validEnv, MQTT_KEY_PATH: '/does/not/exist/key.pem' })).toThrow(
      /MQTT_KEY_PATH.*not found or not readable/,
    );
  });

  it('throws when MQTT_CA_PATH does not exist', () => {
    expect(() => loadConfig({ ...validEnv, MQTT_CA_PATH: '/does/not/exist/ca.pem' })).toThrow(
      /MQTT_CA_PATH.*not found or not readable/,
    );
  });

  it('exposes structured issues on ConfigError', () => {
    let err: ConfigError | undefined;
    try {
      loadConfig({});
    } catch (e) {
      if (e instanceof ConfigError) err = e;
    }
    expect(err).toBeDefined();
    expect(err?.issues.length).toBeGreaterThanOrEqual(6);
    expect(err?.name).toBe('ConfigError');
  });
});

describe('redactUrl', () => {
  it('redacts user:password from a URL', () => {
    expect(redactUrl('redis://user:secret@redis:6379/0')).toBe('redis://***@redis:6379/0');
  });

  it('leaves URLs without credentials untouched', () => {
    expect(redactUrl('redis://redis:6379')).toBe('redis://redis:6379');
    expect(redactUrl('mqtts://broker.test:8884')).toBe('mqtts://broker.test:8884');
  });

  it('redacts only the userinfo portion', () => {
    expect(redactUrl('redis://u:p@host:6379/0?foo=bar')).toBe('redis://***@host:6379/0?foo=bar');
  });
});

describe('sanitizedConfigForLog', () => {
  it('omits MQTT_KEY_PATH from the snapshot', () => {
    const cfg = loadConfig(validEnv);
    const snapshot = sanitizedConfigForLog(cfg);

    expect(Object.keys(snapshot)).not.toContain('keyPath');
    expect(JSON.stringify(snapshot)).not.toContain(cfg.MQTT_KEY_PATH);
  });

  it('redacts credentials in URLs', () => {
    const cfg = loadConfig({
      ...validEnv,
      MQTT_BROKER_URL: 'mqtts://user:secret@broker.test:8884',
      REDIS_URL: 'redis://user:secret@redis.test:6379/0',
    });
    const snapshot = sanitizedConfigForLog(cfg);

    expect(snapshot['brokerUrl']).toBe('mqtts://***@broker.test:8884');
    expect(snapshot['redisUrl']).toBe('redis://***@redis.test:6379/0');
  });

  it('includes cert/CA paths but not key path', () => {
    const cfg = loadConfig(validEnv);
    const snapshot = sanitizedConfigForLog(cfg);

    expect(snapshot['certPath']).toBe(cfg.MQTT_CERT_PATH);
    expect(snapshot['caPath']).toBe(cfg.MQTT_CA_PATH);
  });
});
