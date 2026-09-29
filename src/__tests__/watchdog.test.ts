import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetState, state } from '../state.js';
import type { StuckLimits } from '../watchdog.js';
import { detectStuck, startWatchdog } from '../watchdog.js';

// The container's restart policy restarts a bridge that EXITS; it does nothing for one
// that stays alive and stuck, and the compose health check (`kill -0 1`) asked only
// whether PID 1 existed. Three conditions leave the bridge alive and doing nothing:
//
//   mqtt_down        - the broker connection lost and not coming back (mqtt.js retries
//                      forever while the broker refuses it, and never retries at all
//                      with MQTT_RECONNECT_PERIOD=0);
//   inbound_stalled  - a Redis push that neither resolves nor rejects
//                      (maxRetriesPerRequest: null), and mqtt.js handles inbound
//                      packets one at a time, so the whole fleet's ingest waits on it;
//   unacked_pending  - a push that was refused, so its PUBACK was withheld; the broker
//                      resends an unacknowledged message only on a NEW connection
//                      (retry_interval = infinity on the deployed broker), and after
//                      max_inflight (32) of them it stops delivering altogether.
//
// Each is detected from src/state.ts and ends the process, so the restart policy does
// what it exists for.

const limits: StuckLimits = { mqttDownMs: 120_000, inboundStallMs: 60_000 };

beforeEach(() => {
  resetState();
  state.mqttDownSince = null;
});

describe('detectStuck', () => {
  it('finds nothing while connected, with nothing in hand and nothing unacknowledged', () => {
    expect(detectStuck(10_000_000, limits)).toBeNull();
  });

  it('finds the broker connection down once it has been down for the limit, not before', () => {
    state.mqttDownSince = 1_000;

    expect(detectStuck(1_000 + 119_999, limits)).toBeNull();
    expect(detectStuck(1_000 + 120_000, limits)).toEqual({
      reason: 'mqtt_down',
      forMs: 120_000,
      limitMs: 120_000,
    });
  });

  it('finds the inbound pump stalled once one message has been in hand for the limit', () => {
    state.inboundInFlight.set(1, 10_000);

    expect(detectStuck(10_000 + 59_999, limits)).toBeNull();
    expect(detectStuck(10_000 + 60_000, limits)).toEqual({
      reason: 'inbound_stalled',
      forMs: 60_000,
      limitMs: 60_000,
    });
  });

  it('measures the stall from the OLDEST message in hand', () => {
    state.inboundInFlight.set(1, 50_000);
    state.inboundInFlight.set(2, 20_000);

    expect(detectStuck(80_000, limits)?.reason).toBe('inbound_stalled');
    expect(detectStuck(80_000, limits)?.forMs).toBe(60_000);
  });

  it('finds an unacknowledged message waiting for a new connection once it has waited the limit', () => {
    state.unackedSince = 5_000;

    expect(detectStuck(5_000 + 59_999, limits)).toBeNull();
    expect(detectStuck(5_000 + 60_000, limits)).toEqual({
      reason: 'unacked_pending',
      forMs: 60_000,
      limitMs: 60_000,
    });
  });

  it('names the broker first when it is down - the other two follow from it', () => {
    state.mqttDownSince = 0;
    state.inboundInFlight.set(1, 0);
    state.unackedSince = 0;

    expect(detectStuck(500_000, limits)?.reason).toBe('mqtt_down');
  });
});

describe('startWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onStuck once when a condition holds past its limit, and stops checking', () => {
    state.mqttDownSince = 0;
    const onStuck = vi.fn();
    startWatchdog({ limits, onStuck });

    vi.advanceTimersByTime(119_000);
    expect(onStuck).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6_000);
    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck.mock.calls[0]?.[0]).toMatchObject({ reason: 'mqtt_down', limitMs: 120_000 });

    vi.advanceTimersByTime(600_000);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the condition clears before its limit', () => {
    state.mqttDownSince = 0;
    const onStuck = vi.fn();
    startWatchdog({ limits, onStuck });

    vi.advanceTimersByTime(100_000);
    state.mqttDownSince = null;
    vi.advanceTimersByTime(600_000);

    expect(onStuck).not.toHaveBeenCalled();
  });

  it('stop() ends the checks', () => {
    state.mqttDownSince = 0;
    const onStuck = vi.fn();
    const watchdog = startWatchdog({ limits, onStuck });

    watchdog.stop();
    vi.advanceTimersByTime(600_000);

    expect(onStuck).not.toHaveBeenCalled();
  });
});
