/**
 * Public stream surface for the Cursor provider.
 *
 * All chat traffic goes through the native `streamSimple` path. The legacy
 * OpenAI-compatible local proxy that used to live alongside it in native-core
 * was removed in favour of a single code path.
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
  appendDriftDiagnostic,
  enhanceCursorStreamError,
  isAuthErrorMessage,
  isProtocolMismatchMessage,
} from "./protocol.js";
export {
  formatDriftSummary,
  getDriftSignals,
  hasStrandingDrift,
  recordDriftSignal,
  recordUnknownFields,
  type DriftKind,
  type DriftSignal,
} from "./drift.js";
export { handleInteractionQuery } from "./interaction-query.js";
