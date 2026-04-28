export interface BridgeState {
  mqttConnected: boolean;
  lastMessageReceivedAt: Date | null;
  inflightOutbound: number;
  reconnectCount: number;
}

export const state: BridgeState = {
  mqttConnected: false,
  lastMessageReceivedAt: null,
  inflightOutbound: 0,
  reconnectCount: 0,
};

/** Test-only helper: reset the singleton so tests don't leak state across cases. */
export const resetState = (): void => {
  state.mqttConnected = false;
  state.lastMessageReceivedAt = null;
  state.inflightOutbound = 0;
  state.reconnectCount = 0;
};
