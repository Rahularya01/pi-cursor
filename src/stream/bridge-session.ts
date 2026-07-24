/**
 * The active-bridge registry and the h2-bridge lifecycle that fills it.
 *
 * These two belong together: a bridge parked mid-tool is only reachable through
 * the registry, and every registry eviction path has to tear the bridge down
 * (cancel action + heartbeat timer) rather than just dropping the reference.
 *
 * Conversation/checkpoint state lives one layer up in ./session-state.ts, which
 * imports this module — never the other way around.
 */
import { create, toBinary } from "@bufbuild/protobuf";

import {
  AgentClientMessageSchema,
  ClientHeartbeatSchema,
  CancelActionSchema,
  ConversationActionSchema,
} from "../proto/agent_pb.js";
import {
  frameConnectMessage,
  spawnBridge,
  type BridgeFactory,
  type BridgeHandle,
} from "../client/bridge.js";
import { getCursorAgentUrl } from "./config.js";
import { debugLog } from "./debug-log.js";
import {
  ACTIVE_BRIDGE_TTL_MS,
  resolveH2ConnectTimeoutMs,
  resolveH2IdleTimeoutMs,
} from "./tuning.js";
import type { ActiveBridge } from "./types.js";

/** Test seam: the bridge factory used for both streaming and unary RPCs. */
export function getBridgeFactory(): BridgeFactory {
  return bridgeFactory;
}

export const activeBridges = new Map<string, ActiveBridge>();

const defaultBridgeFactory: BridgeFactory = (options) => spawnBridge(options, debugLog);

let bridgeFactory: BridgeFactory = defaultBridgeFactory;

export function setBridgeFactoryForTests(factory?: BridgeFactory): void {
  bridgeFactory = factory ?? defaultBridgeFactory;
}

export function clearActiveBridgeToolTimeout(active: ActiveBridge | undefined): void {
  if (active?.toolTimeoutTimer) clearTimeout(active.toolTimeoutTimer);
}

export function removeActiveBridge(bridgeKey: string): void {
  clearActiveBridgeToolTimeout(activeBridges.get(bridgeKey));
  activeBridges.delete(bridgeKey);
}

export function setActiveBridge(
  bridgeKey: string,
  active: Omit<ActiveBridge, "toolTimeoutTimer">,
): void {
  clearActiveBridgeToolTimeout(activeBridges.get(bridgeKey));
  const toolTimeoutTimer = setTimeout(() => {
    debugLog("bridge.active_ttl_expired", { bridgeKey, ttlMs: ACTIVE_BRIDGE_TTL_MS });
    cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  }, ACTIVE_BRIDGE_TTL_MS);
  toolTimeoutTimer.unref?.();
  activeBridges.set(bridgeKey, { ...active, toolTimeoutTimer });
}

export function makeHeartbeatBytes(): Uint8Array {
  const heartbeat = create(AgentClientMessageSchema, {
    message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}

export function startBridge(accessToken: string, requestBytes: Uint8Array) {
  const bridge = bridgeFactory({
    accessToken,
    rpcPath: "/agent.v1.AgentService/Run",
    url: getCursorAgentUrl(),
    connectTimeoutMs: resolveH2ConnectTimeoutMs(process.env.PI_CURSOR_H2_CONNECT_TIMEOUT_MS),
    idleTimeoutMs: resolveH2IdleTimeoutMs(process.env.PI_CURSOR_H2_IDLE_TIMEOUT_MS),
  });
  debugLog("bridge.start_run", { requestBytes });
  bridge.write(frameConnectMessage(requestBytes));
  // Keep heartbeats referenced so long tool pauses do not look idle to the process.
  const heartbeatTimer = setInterval(() => bridge.write(makeHeartbeatBytes()), 5_000);
  return { bridge, heartbeatTimer };
}

export function sendCancelAction(bridge: BridgeHandle): void {
  debugLog("bridge.cancel_action", {});
  const action = create(ConversationActionSchema, {
    action: { case: "cancelAction", value: create(CancelActionSchema, {}) },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "conversationAction", value: action },
  });
  bridge.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

export function cleanupBridge(
  bridge: BridgeHandle,
  heartbeatTimer: ReturnType<typeof setInterval>,
  bridgeKey: string,
): void {
  debugLog("bridge.cleanup", { bridgeKey, alive: bridge.alive });
  clearInterval(heartbeatTimer);
  clearActiveBridgeToolTimeout(activeBridges.get(bridgeKey));
  if (bridge.alive) {
    sendCancelAction(bridge);
    bridge.end();
  }
  activeBridges.delete(bridgeKey);
}
