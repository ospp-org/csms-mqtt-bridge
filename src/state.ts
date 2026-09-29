interface BridgeState {
  mqttConnected: boolean;
  redisConnected: boolean;
  lastMessageReceivedAt: Date | null;
  reconnectCount: number;
  /**
   * Epoch ms from which the broker connection has been down, kept from the FIRST loss
   * (mqtt.js follows a close with offline and a stream of reconnects); null while
   * connected. The process starts down: it has no connection until the first CONNACK.
   */
  mqttDownSince: number | null;
  /** Receipt time (epoch ms) of each inbound message whose Redis push has not settled, by delivery. */
  inboundInFlight: Map<number, number>;
  /**
   * Epoch ms of the first inbound message left UNACKNOWLEDGED on the current connection
   * (its push was refused, so its PUBACK was withheld); null when there is none. The
   * broker resends such a message only on a new connection, so a new connection clears it.
   */
  unackedSince: number | null;
}

export const state: BridgeState = {
  mqttConnected: false,
  redisConnected: false,
  lastMessageReceivedAt: null,
  reconnectCount: 0,
  mqttDownSince: Date.now(),
  inboundInFlight: new Map(),
  unackedSince: null,
};

/** Receipt time of the longest-held inbound message still in hand, or null when none is. */
export const oldestInboundInFlight = (): number | null => {
  let oldest: number | null = null;
  for (const receivedAt of state.inboundInFlight.values()) {
    if (oldest === null || receivedAt < oldest) oldest = receivedAt;
  }
  return oldest;
};

/** Test-only helper: reset the singleton so tests don't leak state across cases. */
export const resetState = (): void => {
  state.mqttConnected = false;
  state.redisConnected = false;
  state.lastMessageReceivedAt = null;
  state.reconnectCount = 0;
  state.mqttDownSince = Date.now();
  state.inboundInFlight.clear();
  state.unackedSince = null;
};
