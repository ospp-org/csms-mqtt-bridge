import { oldestInboundInFlight, state } from './state.js';

/**
 * The three ways the bridge stays alive and does nothing. The container's restart
 * policy restarts a bridge that EXITS; a stuck one it never touches, and the compose
 * health check asked only whether PID 1 existed. So the bridge decides it is stuck
 * itself, and ends the process.
 *
 *   mqtt_down        The broker connection is gone and not coming back. mqtt.js retries
 *                    every MQTT_RECONNECT_PERIOD for as long as the broker refuses it
 *                    (an expired or rotated certificate, an ACL that no longer admits
 *                    the client id), and never retries with MQTT_RECONNECT_PERIOD=0.
 *                    The process starts down, so a broker never reached counts too.
 *
 *   inbound_stalled  One inbound message has been in hand past the limit: its Redis push
 *                    neither resolved nor rejected (maxRetriesPerRequest: null queues a
 *                    command for as long as Redis is gone). mqtt.js handles inbound
 *                    packets one at a time, so every station's messages wait behind it.
 *
 *   unacked_pending  A push was refused, so the bridge withheld the PUBACK and the broker
 *                    kept the message - and resends it only on a NEW connection
 *                    (retry_interval = infinity on the deployed broker). Until then it
 *                    waits, however healthy Redis is again, and after max_inflight (32)
 *                    such messages the broker delivers nothing more to this session.
 *
 * Restarting loses nothing in any of the three: the session is persistent (clean:false
 * with a session expiry), no message in hand or refused was acknowledged, and the broker
 * resends every unacknowledged one on the next connection.
 */
export type StuckReason = 'mqtt_down' | 'inbound_stalled' | 'unacked_pending';

export interface StuckLimits {
  /** How long the broker connection may stay down. */
  mqttDownMs: number;
  /** How long one message may stay in hand, or unacknowledged waiting for a new connection. */
  inboundStallMs: number;
}

export interface Stuck {
  reason: StuckReason;
  /** How long the condition has held, in ms. */
  forMs: number;
  limitMs: number;
}

const held = (since: number | null, now: number): number | null =>
  since === null ? null : now - since;

/**
 * The stuck condition that holds at `now`, or null. The broker is named first when it
 * is down, because a message left in hand or unacknowledged follows from that.
 */
export const detectStuck = (now: number, limits: StuckLimits): Stuck | null => {
  const down = held(state.mqttDownSince, now);
  if (down !== null && down >= limits.mqttDownMs) {
    return { reason: 'mqtt_down', forMs: down, limitMs: limits.mqttDownMs };
  }

  const stalled = held(oldestInboundInFlight(), now);
  if (stalled !== null && stalled >= limits.inboundStallMs) {
    return { reason: 'inbound_stalled', forMs: stalled, limitMs: limits.inboundStallMs };
  }

  const unacked = held(state.unackedSince, now);
  if (unacked !== null && unacked >= limits.inboundStallMs) {
    return { reason: 'unacked_pending', forMs: unacked, limitMs: limits.inboundStallMs };
  }

  return null;
};

export interface WatchdogDeps {
  limits: StuckLimits;
  /** Called once, with what was found; the watchdog stops checking before it calls. */
  onStuck: (stuck: Stuck) => void;
}

export interface Watchdog {
  stop(): void;
}

/**
 * Checks at a quarter of the shorter limit, between 250 ms and 5 s, so a condition is
 * acted on within a quarter-limit of reaching it. The timer is unref'd: the watchdog
 * never keeps a process alive on its own.
 */
export const startWatchdog = ({ limits, onStuck }: WatchdogDeps): Watchdog => {
  const intervalMs = Math.min(
    5_000,
    Math.max(250, Math.floor(Math.min(limits.mqttDownMs, limits.inboundStallMs) / 4)),
  );

  const timer = setInterval(() => {
    const stuck = detectStuck(Date.now(), limits);
    if (stuck === null) return;
    clearInterval(timer);
    onStuck(stuck);
  }, intervalMs);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
};
