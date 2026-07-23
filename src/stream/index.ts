/**
 * Public stream surface for the Cursor provider.
 *
 * The legacy OpenAI-compatible local proxy (`startProxy`) remains inside
 * native-core for internal/debug use but is intentionally not re-exported here.
 */
export {
  createCursorNativeStream,
  getCursorModels,
  getCursorParameterizedModels,
  cleanupSessionState,
  cleanupAllSessionState,
  type CursorModel,
  type CursorNativeStreamConfig,
} from "./native-core.js";

export { getCursorAgentUrl, getCursorClientVersion } from "./config.js";
export {
  resolveModelId,
  resolveRequestedModelId,
  type CursorNativeModelRouting,
} from "./model-routing.js";
export {
  isContextModeSideChannelText,
  normalizeMessagesForCursor,
  frameContextModeSideChannel,
} from "./context-normalize.js";
export {
  planRecovery,
  fingerprintCompletedTurns,
  wrapRecoveredToolResults,
  lostToolContinuationErrorBody,
  formatLostToolContinuationDiagnostic,
  type RecoveryDecision,
  type PlanRecoveryInput,
  type StoredConversation,
} from "./recovery.js";
export {
  enhanceCursorStreamError,
  isAuthErrorMessage,
  isProtocolMismatchMessage,
} from "./protocol.js";
