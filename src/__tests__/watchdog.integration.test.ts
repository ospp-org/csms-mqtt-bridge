/**
 * The process-level proof for the watchdog: a bridge that cannot reach its broker EXITS,
 * non-zero and naming why, so the container's restart policy restarts it.
 *
 * The unit tests in watchdog.test.ts pin the detection; only a real process can show the
 * exit, because index.ts is where detection meets process.exit. The entry point runs
 * under tsx against a real Redis (bootstrap refuses to touch the broker before Redis is
 * ready) and a broker address nothing listens on, with a real throwaway certificate. Before the watchdog, this process ran
 * forever: mqtt.js retried every MQTT_RECONNECT_PERIOD and nothing else ever ended it.
 *
 * Set REDIS_INTEGRATION_URL to run; CI provides it, and the first case fails the build
 * if that ever stops being true.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env['REDIS_INTEGRATION_URL'];

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  elapsedMs: number;
}

const runBridge = (env: Record<string, string>, timeoutMs: number): Promise<Exit> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: join(import.meta.dirname, '..', '..'),
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the bridge was still running after ${timeoutMs.toString()} ms:\n${stdout}`));
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, elapsedMs: Date.now() - started });
    });
  });

it('watchdog process suite must not be silently skipped in CI', () => {
  if (process.env['CI'] === 'true') {
    expect(
      url,
      'REDIS_INTEGRATION_URL is unset in CI - the watchdog exit proof would not have run',
    ).toBeTruthy();
  }
});

describe.skipIf(!url)('watchdog - a stuck bridge exits so its restart policy restarts it', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'csms-bridge-watchdog-'));
    // A real, throwaway key pair: mqtt.js switches to TLS whenever a cert and a key are
    // set, whatever the URL's scheme, and a file that is not PEM throws in tls.connect
    // before any connection is tried - the startup exit, not the one under test.
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
        '-days', '1', '-subj', '/CN=csms-itest-watchdog',
      ],
      { stdio: 'ignore' },
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1, naming mqtt_down, when the broker stays unreachable past WATCHDOG_MQTT_DOWN_MS', async () => {
    const broker = await freePort(); // bound and released: nothing listens there now
    const metrics = await freePort();

    const exit = await runBridge(
      {
        MQTT_BROKER_URL: `mqtts://127.0.0.1:${broker.toString()}`,
        MQTT_CLIENT_ID: 'csms-itest-watchdog',
        MQTT_CERT_PATH: join(dir, 'cert.pem'),
        MQTT_KEY_PATH: join(dir, 'key.pem'),
        MQTT_RECONNECT_PERIOD: '200',
        REDIS_URL: url ?? '',
        REDIS_QUEUE_INCOMING: 'csms-bridge-itest:watchdog',
        // The eviction suite flips this Redis to allkeys-lru while it runs; this proof
        // is about the watchdog, so the durability refusal is downgraded to a warning
        // rather than left to race it.
        REDIS_REQUIRE_NOEVICTION: 'false',
        METRICS_PORT: metrics.toString(),
        WATCHDOG_MQTT_DOWN_MS: '1500',
        SHUTDOWN_TIMEOUT_MS: '2000',
        LOG_LEVEL: 'info',
      },
      30_000,
    );

    expect(exit.signal).toBeNull();
    expect(exit.code, exit.stdout).toBe(1);
    expect(exit.stdout).toContain('"reason":"mqtt_down"');
    expect(exit.stdout).toContain('bridge is stuck');
    // Not the startup path: bootstrap passed and the broker was really tried.
    expect(exit.stdout).toContain('redis ready; asserting queue durability');
    expect(exit.stdout).toContain('mqtt reconnecting');
  }, 40_000);
});
