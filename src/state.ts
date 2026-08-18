interface BridgeState {
  mqttConnected: boolean;
  redisConnected: boolean;
  lastMessageReceivedAt: Date | null;
  reconnectCount: number;
}

export const state: BridgeState = {
  mqttConnected: false,
  redisConnected: false,
  lastMessageReceivedAt: null,
  reconnectCount: 0,
};

/** Test-only helper: reset the singleton so tests don't leak state across cases. */
export const resetState = (): void => {
  state.mqttConnected = false;
  state.redisConnected = false;
  state.lastMessageReceivedAt = null;
  state.reconnectCount = 0;
};
