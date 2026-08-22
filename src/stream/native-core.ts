/**
 * Cursor native provider runtime: translates Pi streamSimple context to Cursor's
 * protobuf/HTTP2 Connect protocol.
 *
 * Based on https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan.
 * Uses Node's http2 via a child process bridge (h2-bridge.mjs).
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecClientMessageSchema,
  McpResultSchema,
  McpSuccessSchema,
  type McpToolDefinition,
} from "../proto/agent_pb.js";
import {
  createConnectFrameParser,
  frameConnectMessage,
  parseConnectEndStream,
  type BridgeHandle,
  type ConnectFrameDesyncDiagnostics,
} from "../client/bridge.js";
import type { CursorModelParameter } from "../client/cursor-wire.js";
export type {
  CursorModelParameter,
  CursorParameterizedModel,
  CursorParameterizedVariant,
} from "../client/cursor-wire.js";

import { processServerMessage } from "./server-messages.js";
import { createThinkingTagFilter } from "./thinking-filter.js";
import {
  contextToCursorChatCompletionRequest,
  nativeRequestParameterError,
  resolveNativeReasoningEffort,
  resolveToolsForToolChoice,
} from "./pi-adapter.js";
import {
  clearStoredMidPauseMetadata,
  commitStoredCheckpoint,
  commitStoredCheckpointMidPause,
  conversationStates,
  deriveBridgeKey,
  deriveConversationKey,
  derivePiSessionId,
  deriveRequestLockKey,
  deterministicConversationId,
  discardStaleCheckpointIfNeeded,
  evictStaleConversations,
  fingerprintCompletedTurns,
  getOrHydrateConversation,
  handleBridgeCloseMidPause,
  mergeBlobStore,
  persistAbortedConversationState,
  trimBlobStore,
  withSessionLock,
} from "./session-state.js";
export {
  cleanupAllSessionState,
  cleanupSessionState,
  commitStoredCheckpointMidPause,
  deriveBridgeKey,
  deriveBridgeKeyFromSessionId,
  deriveConversationKey,
  deriveConversationKeyFromSessionId,
  derivePiSessionId,
  deterministicConversationId,
  evictStaleConversations,
  fingerprintCompletedTurns,
  handleBridgeCloseMidPause,
  type HandleBridgeCloseMidPauseInput,
} from "./session-state.js";
import {
  buildCursorRequest,
  buildMcpSuccessContent,
  buildMcpToolDefinitions,
  isIdentityConversationalTurn,
  isTrivialConversationalTurn,
  normalizeToolResultForTransport,
  summarizeRequestSize,
} from "./request-build.js";
export {
  buildCursorRequest,
  isIdentityConversationalTurn,
  isSlimToolsEnabled,
  isTrivialConversationalTurn,
  slimOpenAIToolsForCursor,
  summarizeRequestSize,
  type BuildCursorRequestOptions,
} from "./request-build.js";
import { hashSystemPrompt } from "./root-prompt.js";
export {
  buildRootPromptMessages,
  hashSystemPrompt,
  isPromptHistoryEnabled,
  turnRootMessages,
} from "./root-prompt.js";
import {
  appendAssistantTextToTurn,
  getTurnToolCallResults,
  parseMessages,
  parseToolCallArguments,
  stripInFlightResults,
  systemPromptHasSessionMemory,
} from "./message-parsing.js";
export {
  frameContextModeSideChannel,
  isContextModeSideChannelText,
  normalizeMessagesForCursor,
  parseMessages,
  systemPromptHasSessionMemory,
} from "./message-parsing.js";
export {
  callCursorUnaryRpc,
  discoverCursorCatalog,
  getCursorModels,
  getCursorParameterizedModels,
  inferCursorContextWindow,
  type CursorCatalog,
  type CursorModel,
} from "./model-discovery.js";
export { readCachedCatalog, writeCachedCatalog } from "./model-cache.js";
import {
  activeBridges,
  cleanupBridge,
  parkIdleBridge,
  removeActiveBridge,
  setActiveBridge,
  startBridge,
} from "./bridge-session.js";
export { setBridgeFactoryForTests } from "./bridge-session.js";
import {
  canBlindIdleRestart,
  canRecoverAfterTransportLoss,
  createStreamIdleWatchdog,
  interactionUpdateCountsAsProgress,
  resolveH2ConnectTimeoutMs,
  resolveH2IdleTimeoutMs,
  resolveMidPauseRebuildMaxAgeMs,
  resolveResumeIdleTimeoutMs,
  resolveStreamIdleMaxRetries,
  resolveStreamIdleTimeoutMs,
} from "./tuning.js";
export {
  canBlindIdleRestart,
  canRecoverAfterTransportLoss,
  interactionUpdateCountsAsProgress,
  resolveActiveBridgeTtlMs,
  resolveH2ConnectTimeoutMs,
  resolveH2IdleTimeoutMs,
  resolveResumeIdleTimeoutMs,
  resolveStreamIdleMaxRetries,
  resolveStreamIdleTimeoutMs,
} from "./tuning.js";
import {
  CHECKPOINT_CONTINUATION_PROMPT,
  classifyBridgeExit,
  formatTransportFailure,
} from "./transport-errors.js";
export {
  CHECKPOINT_CONTINUATION_PROMPT,
  classifyBridgeExit,
  formatTransportFailure,
  type TransportFailure,
} from "./transport-errors.js";
import {
  debugBase64ImageSummary,
  debugLog,
  decodeRequestForTests,
  emitMetric,
  lifecycleLog,
  nextDebugRequestId,
  redactForDebug,
  setMetricEmitter,
  type MetricEmitter,
} from "./debug-log.js";
import { cloneParsedImage } from "./images.js";
import {
  resolveModelId as resolveModelIdImpl,
  resolveRequestedModelId as resolveRequestedModelIdImpl,
  type CursorNativeModelRouting as ExtractedCursorNativeModelRouting,
  type CursorResolvableModel as ExtractedCursorResolvableModel,
  type ResolvedCursorModelRouting as ExtractedResolvedCursorModelRouting,
} from "./model-routing.js";
import { liveTranscript, withSyntheticCurrentTurn } from "./client-transcript.js";
import {
  planRecovery as planRecoveryImpl,
  wrapRecoveredToolResults as wrapRecoveredToolResultsImpl,
  collapseToolResultsById as collapseToolResultsByIdImpl,
  lostToolContinuationErrorBody as lostToolContinuationErrorBodyImpl,
  formatLostToolContinuationDiagnostic as formatLostToolContinuationDiagnosticImpl,
  lostToolContinuationMessage as lostToolContinuationMessageImpl,
  bridgeKeyPrefix as bridgeKeyPrefixImpl,
  type RecoveryDecision as ExtractedRecoveryDecision,
  type PlanRecoveryInput as ExtractedPlanRecoveryInput,
  type LostToolContinuationDiagnosticInput as ExtractedLostToolContinuationDiagnosticInput,
} from "./recovery.js";
import { enhanceCursorStreamError, isAuthErrorMessage } from "./protocol.js";
import {
  setLastIdleTimeout,
  setLastRecoverySkipReason,
  setLastRequestSize,
  setLastStreamEvent,
} from "../diagnostics/diagnostics.js";

// URL resolution lives in ./config.ts
export { getCursorAgentUrl } from "./config.js";

// ── Types ──
//
// The shared structural types live in ./types.ts so recovery/parsing/building
// modules can reference them without importing this runtime.

import type {
  ActiveBridge,
  ChatCompletionRequest,
  CheckpointRef,
  ClientTranscript,
  CursorNativeStreamConfig,
  CursorNativeStreamOptions,
  IdleRestartContext,
  NativeStreamAttemptInput,
  NativeStreamWriter,
  ParsedImageContent,
  ParsedMessages,
  ParsedTurn,
  ParsedToolCallStep,
  PendingExec,
  StreamIdleRetryController,
  StreamState,
  ToolResultInfo,
} from "./types.js";

export type {
  CursorNativeStreamConfig,
  ParsedAssistantTextStep,
  ParsedImageContent,
  ParsedToolCallStep,
  ParsedToolResult,
  ParsedTurn,
  ParsedTurnStep,
  StoredConversation,
} from "./types.js";

// ── State ──

export const __testInternals = {
  activeBridges,
  conversationStates,
  createStreamIdleWatchdog,
  canBlindIdleRestart,
  canRecoverAfterTransportLoss,
  clearStoredMidPauseMetadata,
  collectToolResultImages,
  debugBase64ImageSummary,
  decodeRequestForTests,
  discardStaleCheckpointIfNeeded,
  fingerprintCompletedTurns,
  getOrHydrateConversation,
  interactionUpdateCountsAsProgress,
  redactForDebug,
  resolveH2ConnectTimeoutMs,
  resolveH2IdleTimeoutMs,
  resolveMidPauseRebuildMaxAgeMs,
  resolveNativeReasoningEffort,
  resolveResumeIdleTimeoutMs,
  resolveStreamIdleMaxRetries,
  resolveStreamIdleTimeoutMs,
  persistAbortedConversationState,
  trimBlobStore,
  classifyBridgeExit,
  writeNativeStream,
  setMetricEmitterForTests(factory?: MetricEmitter) {
    setMetricEmitter(factory);
  },
};

// ── Native pi streamSimple provider ──

export type CursorNativeModelRouting = ExtractedCursorNativeModelRouting;
import { createNativeStreamWriter } from "./stream-writer.js";
export { createNativeStreamWriter } from "./stream-writer.js";

function lostToolContinuationMessage(): string {
  return lostToolContinuationMessageImpl();
}

export type LostToolContinuationDiagnosticInput = ExtractedLostToolContinuationDiagnosticInput;

export function lostToolContinuationErrorBody(input: LostToolContinuationDiagnosticInput): {
  error: Record<string, unknown>;
} {
  return lostToolContinuationErrorBodyImpl(input);
}

function bridgeKeyPrefix(bridgeKey: string): string {
  return bridgeKeyPrefixImpl(bridgeKey);
}

export function formatLostToolContinuationDiagnostic(
  input: LostToolContinuationDiagnosticInput,
): string {
  return formatLostToolContinuationDiagnosticImpl(input);
}

export function wrapRecoveredToolResults(
  toolResults: Array<Pick<ToolResultInfo, "toolCallId" | "content">>,
  recoveryId: string = crypto.randomUUID(),
): string {
  return wrapRecoveredToolResultsImpl(toolResults, recoveryId);
}

function collectToolResultImages(toolResults: ToolResultInfo[]): ParsedImageContent[] {
  return collapseToolResultsByIdImpl(toolResults).flatMap((result) =>
    (result.images ?? []).map(cloneParsedImage),
  );
}

function toolResultsContainRecoverySentinel(
  toolResults: Array<Pick<ToolResultInfo, "content">>,
): boolean {
  return toolResults.some(
    (result) =>
      result.content.includes("[Recovered tool output after upstream bridge loss") ||
      result.content.includes("[End recovered tool output"),
  );
}

function parsedTurnHasImages(turn: ParsedTurn): boolean {
  return (turn.userImages?.length ?? 0) > 0;
}

type FullHistoryRebuildDecision = Extract<RecoveryDecision, { kind: "rebuild_full_history" }>;

function logFullHistoryRebuild(
  event: "native.rebuild_full_history" | "chat.rebuild_full_history",
  input: {
    requestId?: string;
    bridgeKey: string;
    convKey: string;
    modelId: string;
    decision: FullHistoryRebuildDecision;
  },
): void {
  const fields = {
    requestId: input.requestId,
    bridgeKeyPrefix: bridgeKeyPrefix(input.bridgeKey),
    convKey: input.convKey,
    modelId: input.modelId,
    rebuildReason: input.decision.rebuildReason,
    completedTurnCount: input.decision.completedTurns.length,
    inFlightTurnHasImages: parsedTurnHasImages(input.decision.inFlightTurn),
    toolResultCount: input.decision.toolResults.length,
    pendingToolCallIds: input.decision.toolResults.map((result) => result.toolCallId),
    sentinelInjectionDetected: toolResultsContainRecoverySentinel(input.decision.toolResults),
  };
  debugLog(event, fields);
  const metricFields = {
    metric: "cursor_provider.rebuild_full_history",
    reason: input.decision.rebuildReason,
    model: input.modelId,
    count: 1,
    requestId: input.requestId,
    bridgeKeyPrefix: bridgeKeyPrefix(input.bridgeKey),
    convKey: input.convKey,
  };
  debugLog("metric.cursor_provider.rebuild_full_history", metricFields);
  emitMetric("metric.cursor_provider.rebuild_full_history", metricFields);
}

export type RecoveryDecision = ExtractedRecoveryDecision;
export type PlanRecoveryInput = ExtractedPlanRecoveryInput;

export function planRecovery(input: PlanRecoveryInput): RecoveryDecision {
  return planRecoveryImpl({
    ...input,
    discardStaleCheckpoint: discardStaleCheckpointIfNeeded,
  });
}

export function createCursorNativeStream(
  config: CursorNativeStreamConfig,
): (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const writer = createNativeStreamWriter(stream, model);
    writer.start();

    (async () => {
      let body = contextToCursorChatCompletionRequest(
        model,
        context,
        options as CursorNativeStreamOptions | undefined,
        config,
      );

      if (options?.onPayload) {
        const replacement = await options.onPayload(body, model);
        if (replacement && typeof replacement === "object")
          body = replacement as ChatCompletionRequest;
      }

      await withSessionLock(deriveRequestLockKey(body), async () => {
        if (writer.closed) return;
        const accessToken = await config.getAccessToken();
        await handleCursorNativeRequest(
          body,
          accessToken,
          model,
          options as CursorNativeStreamOptions | undefined,
          writer,
          nextDebugRequestId(),
          config.getAccessToken,
        );
      });
    })().catch((error) => {
      writer.error(error instanceof Error ? error.message : String(error), "error");
    });

    return stream;
  };
}

async function handleCursorNativeRequest(
  body: ChatCompletionRequest,
  accessToken: string,
  model: Model<Api>,
  options: CursorNativeStreamOptions | undefined,
  writer: NativeStreamWriter,
  requestId: string,
  getAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string>,
): Promise<void> {
  let parsedMessages: ParsedMessages;
  try {
    parsedMessages = parseMessages(body.messages, body.cursor_tool_result_images);
  } catch (error) {
    writer.error(error instanceof Error ? error.message : String(error), "error");
    return;
  }

  const parameterError = nativeRequestParameterError(body);
  if (parameterError) {
    debugLog("native.unsupported_parameters", { requestId, message: parameterError });
    writer.error(parameterError, "error");
    return;
  }

  const toolResolution = resolveToolsForToolChoice(body.tools ?? [], body.tool_choice);
  if ("error" in toolResolution) {
    debugLog("native.unsupported_tool_choice", { requestId, tool_choice: body.tool_choice });
    writer.error(toolResolution.error, "error");
    return;
  }

  const { systemPrompt, userText, userImages, turns, toolResults, inFlightTurn } = parsedMessages;
  const omitToolsForTrivialTurn =
    toolResolution.tools.length > 0 &&
    toolResults.length === 0 &&
    userImages.length === 0 &&
    isTrivialConversationalTurn(userText);
  const selectedTools = omitToolsForTrivialTurn ? [] : toolResolution.tools;
  // Greetings do not need Pi's large agent prompt: sending it can cost tens of
  // thousands of input tokens before the user text is even considered. Keep the
  // full prompt for anything actionable, for identity/capability questions the
  // prompt itself answers, and whenever it carries folded session/compaction
  // memory.
  const PI_MCP_TOOLS_ONLY =
    "You are running inside Pi, not the Cursor IDE. " +
    "Cursor-native tools (read, write, ls, grep, shell, fetch, delete) are not available. " +
    "Use only the MCP tools listed in this request. " +
    "Do not re-list the workspace or re-read files to recover context unless the latest user message asks you to.";
  // Even a dropped prompt leaves this much behind: without it the model answers
  // a greeting as Cursor's IDE assistant.
  const PI_IDENTITY_ONLY = "You are running inside Pi, not the Cursor IDE.";
  const dropSystemPrompt =
    omitToolsForTrivialTurn &&
    !isIdentityConversationalTurn(userText) &&
    !systemPromptHasSessionMemory(systemPrompt);
  let effectiveSystemPrompt = dropSystemPrompt ? PI_IDENTITY_ONLY : systemPrompt;
  if (selectedTools.length > 0) {
    effectiveSystemPrompt = effectiveSystemPrompt
      ? `${effectiveSystemPrompt}\n\n${PI_MCP_TOOLS_ONLY}`
      : PI_MCP_TOOLS_ONLY;
  }
  if (omitToolsForTrivialTurn) {
    setLastStreamEvent("tools_omitted_trivial_turn");
    lifecycleLog("tools_omitted", {
      requestId,
      reason: "trivial_conversational_turn",
      originalToolCount: toolResolution.tools.length,
      systemPromptDropped: dropSystemPrompt,
    });
  }
  const modelId = resolveRequestedModelId(body.model, body.reasoning_effort, body.cursor_model_id);
  const maxMode =
    typeof body.cursor_model_max_mode === "boolean"
      ? body.cursor_model_max_mode
      : body.cursor_requires_max_mode === true;
  const sessionId = derivePiSessionId(body);
  const bridgeKey = deriveBridgeKey(body.messages, sessionId);
  const convKey = deriveConversationKey(body.messages, sessionId);
  const activeBridge = activeBridges.get(bridgeKey);

  debugLog("native.request", {
    requestId,
    sessionId,
    bridgeKey,
    convKey,
    model: body.model,
    resolvedModelId: modelId,
    cursorModelId: body.cursor_model_id,
    cursorModelParameters: body.cursor_model_parameters,
    cursorRequiresMaxMode: body.cursor_requires_max_mode,
    cursorModelMaxMode: body.cursor_model_max_mode,
    maxMode,
    messageCount: body.messages.length,
    turnCount: turns.length,
    userText,
    toolResults,
    inFlightTurn,
    hasActiveBridge: !!activeBridge,
  });

  if (!userText && userImages.length === 0 && toolResults.length === 0) {
    writer.error("No user message found", "error");
    return;
  }

  if (toolResults.length > 0) {
    const resumeIdleTimeoutMs = resolveResumeIdleTimeoutMs(
      process.env.PI_CURSOR_RESUME_IDLE_TIMEOUT_MS,
    );
    if (activeBridge) {
      removeActiveBridge(bridgeKey);
      // Without a Pi session id the bridge key is only a hash of the opening user message, so two
      // conversations that start alike land on the same key. Resuming the wrong bridge would splice
      // one conversation's tool results into another; the history fingerprint is what tells them
      // apart. Recovery already fingerprints — this closes the same hole on the live path.
      //
      // Scoped to sessionless keys on purpose. A session-derived key cannot collide, so there the
      // check could only ever produce false negatives — tearing down a healthy bridge if the client
      // reshapes its history mid-turn — with no collision to protect against.
      const currentHistoryFingerprint = fingerprintCompletedTurns(turns);
      const historyMatches =
        !!sessionId || activeBridge.historyFingerprint === currentHistoryFingerprint;
      if (!historyMatches) {
        debugLog("bridge.active_history_mismatch", {
          requestId,
          bridgeKey,
          bridgeKeyPrefix: bridgeKeyPrefix(bridgeKey),
          convKey,
          storedFingerprint: activeBridge.historyFingerprint,
          currentFingerprint: currentHistoryFingerprint,
        });
        setLastStreamEvent("active_bridge_history_mismatch");
      }
      if (activeBridge.bridge.alive && historyMatches) {
        handleNativeToolResultResume(
          activeBridge,
          toolResults,
          {
            accessToken,
            systemPrompt,
            model,
            modelId,
            bridgeKey,
            convKey,
            sessionId,
            completedTurns: turns,
            inFlightTurn,
            maxMode,
            cursorModelParameters: body.cursor_model_parameters ?? [],
            getAccessToken,
          },
          writer,
          options,
          requestId,
        );
        return;
      }
      clearInterval(activeBridge.heartbeatTimer);
      activeBridge.bridge.end();
    }
    const recoveryStored = getOrHydrateConversation(convKey);
    const decision = planRecovery({
      stored: recoveryStored,
      toolResults,
      completedTurns: turns,
      inFlightTurn,
      sessionId,
      requestId,
      convKey,
    });
    if (decision.kind === "recover") {
      setLastStreamEvent("recovered_via_checkpoint");
      debugLog("bridge.recovered_via_checkpoint", {
        requestId,
        bridgeKey,
        bridgeKeyPrefix: bridgeKeyPrefix(bridgeKey),
        convKey,
        recoveryPath: "stored_checkpoint",
        pendingToolCallIds: toolResults.map((r) => r.toolCallId),
      });
      const mcpTools = buildMcpToolDefinitions(selectedTools);
      // Images ride the recovered user turn on this path too — dropping them here silently lost
      // screenshots that the rebuild path preserves.
      const recoveredUserImages = collectToolResultImages(toolResults);
      const recoveredCurrentTurn: ParsedTurn = {
        userText: decision.wrappedText,
        steps: [],
        ...(recoveredUserImages.length ? { userImages: recoveredUserImages } : {}),
      };
      const payload = buildCursorRequest({
        modelId,
        systemPrompt,
        userText: decision.wrappedText,
        userImages: recoveredUserImages,
        turns,
        conversationId: decision.conversationId,
        checkpoint: decision.checkpoint,
        existingBlobStore: decision.blobStore,
        maxMode,
        cursorModelParameters: body.cursor_model_parameters,
        mcpTools,
      });
      payload.mcpTools = mcpTools;
      startNativeStreamWithIdleRetries({
        accessToken,
        requestBytes: payload.requestBytes,
        blobStore: payload.blobStore,
        mcpTools: payload.mcpTools,
        model,
        modelId,
        bridgeKey,
        convKey,
        completedTurns: turns,
        currentTurn: recoveredCurrentTurn,
        writer,
        options,
        requestId,
        streamIdleTimeoutMs: resumeIdleTimeoutMs,
        getAccessToken,
        systemPrompt,
        conversationId: decision.conversationId,
        maxMode,
        cursorModelParameters: body.cursor_model_parameters ?? [],
      });
      return;
    }
    if (decision.kind === "rebuild_full_history") {
      setLastStreamEvent("rebuild_full_history");
      logFullHistoryRebuild("native.rebuild_full_history", {
        requestId,
        bridgeKey,
        convKey,
        modelId,
        decision,
      });
      const mcpTools = buildMcpToolDefinitions(selectedTools);
      const rebuiltCompletedTurns = [...decision.completedTurns, decision.inFlightTurn];
      const recoveredUserImages = collectToolResultImages(decision.toolResults);
      const recoveredCurrentTurn: ParsedTurn = {
        userText: decision.wrappedText,
        steps: [],
        ...(recoveredUserImages.length ? { userImages: recoveredUserImages } : {}),
      };
      const payload = buildCursorRequest({
        modelId,
        systemPrompt,
        userText: decision.wrappedText,
        userImages: recoveredUserImages,
        turns: rebuiltCompletedTurns,
        conversationId: decision.conversationId,
        checkpoint: null,
        existingBlobStore: decision.blobStore,
        maxMode,
        cursorModelParameters: body.cursor_model_parameters,
        mcpTools,
      });
      payload.mcpTools = mcpTools;
      if (recoveryStored) recoveryStored.lastAccessMs = Date.now();
      startNativeStreamWithIdleRetries({
        accessToken,
        requestBytes: payload.requestBytes,
        blobStore: payload.blobStore,
        mcpTools: payload.mcpTools,
        model,
        modelId,
        bridgeKey,
        convKey,
        completedTurns: rebuiltCompletedTurns,
        currentTurn: recoveredCurrentTurn,
        writer,
        options,
        requestId,
        streamIdleTimeoutMs: resumeIdleTimeoutMs,
        getAccessToken,
        systemPrompt,
        conversationId: decision.conversationId,
        maxMode,
        cursorModelParameters: body.cursor_model_parameters ?? [],
      });
      return;
    }
    setLastRecoverySkipReason(decision.reason);
    setLastStreamEvent(`recovery_skipped:${decision.reason}`);
    debugLog("bridge.recovery_skipped", {
      requestId,
      bridgeKey,
      bridgeKeyPrefix: bridgeKeyPrefix(bridgeKey),
      convKey,
      skipReason: decision.reason,
      hadStoredCheckpoint: decision.hadStoredCheckpoint,
      ...(decision.expected !== undefined ? { expected: decision.expected } : {}),
      ...(decision.received !== undefined ? { received: decision.received } : {}),
    });
    const message = `${lostToolContinuationMessage()} ${formatLostToolContinuationDiagnostic({
      bridgeKey,
      hadStoredCheckpoint: decision.hadStoredCheckpoint,
      skipReason: decision.reason,
    })}`;
    debugLog("native.lost_tool_continuation", {
      requestId,
      bridgeKey,
      bridgeKeyPrefix: bridgeKeyPrefix(bridgeKey),
      convKey,
      skipReason: decision.reason,
      toolResults,
      message,
    });
    writer.error(message, "error");
    return;
  }

  if (activeBridge && activeBridges.has(bridgeKey)) {
    clearInterval(activeBridge.heartbeatTimer);
    activeBridge.bridge.end();
    removeActiveBridge(bridgeKey);
  }

  let stored = getOrHydrateConversation(convKey);
  if (!stored) {
    stored = {
      conversationId: deterministicConversationId(convKey),
      checkpoint: null,
      sessionScoped: !!sessionId,
      ...(sessionId ? { sessionId } : {}),
      blobStore: new Map(),
      lastAccessMs: Date.now(),
    };
    conversationStates.set(convKey, stored);
  }
  stored.lastAccessMs = Date.now();
  evictStaleConversations();
  discardStaleCheckpointIfNeeded(stored, turns, requestId, convKey);

  const mcpTools = buildMcpToolDefinitions(selectedTools);
  const effectiveUserText = userText;
  const effectiveUserImages = userText || userImages.length > 0 ? userImages : [];
  // Pi rewrites its system prompt as a session evolves (context-mode folds
  // session memory into it). A checkpoint carries the prompt recorded when the
  // conversation started, so a changed prompt has to be re-published.
  const systemPromptHash = hashSystemPrompt(effectiveSystemPrompt);
  const refreshSystemPrompt = !!stored.checkpoint && stored.systemPromptHash !== systemPromptHash;
  const payload = buildCursorRequest({
    modelId,
    systemPrompt: effectiveSystemPrompt,
    userText: effectiveUserText,
    turns,
    conversationId: stored.conversationId,
    checkpoint: stored.checkpoint,
    existingBlobStore: stored.blobStore,
    maxMode,
    cursorModelParameters: body.cursor_model_parameters,
    mcpTools,
    userImages: effectiveUserImages,
    refreshSystemPrompt,
  });
  stored.systemPromptHash = systemPromptHash;
  payload.mcpTools = mcpTools;

  const currentTurn: ParsedTurn = {
    userText: effectiveUserText,
    steps: [],
    ...(effectiveUserImages.length > 0 ? { userImages: effectiveUserImages } : {}),
  };

  const size = summarizeRequestSize({
    systemPrompt: effectiveSystemPrompt,
    userText: effectiveUserText,
    tools: selectedTools,
    mcpTools,
    requestBytes: payload.requestBytes,
    blobStore: payload.blobStore,
    turnCount: turns.length,
  });
  const sizeSummary =
    `approxTokens=${size.approxInputTokens} systemChars=${size.systemChars} ` +
    `userChars=${size.userChars} tools=${size.toolCount} toolJsonChars=${size.toolJsonChars} ` +
    `mcpSchemaBytes=${size.mcpSchemaBytes} requestBytes=${size.requestBytes} ` +
    `blobBytes=${size.blobBytes} wireBytes=${size.wireBytes} turns=${size.turnCount}`;
  setLastRequestSize(sizeSummary);
  lifecycleLog("request_size", {
    requestId,
    bridgeKey: bridgeKeyPrefix(bridgeKey),
    convKey,
    modelId,
    ...size,
  });

  debugLog("native.dispatch_stream", {
    requestId,
    bridgeKey,
    convKey,
    conversationId: stored.conversationId,
    hasCheckpoint: !!stored.checkpoint,
    requestSize: size,
    payload,
  });
  startNativeStreamWithIdleRetries({
    accessToken,
    requestBytes: payload.requestBytes,
    blobStore: payload.blobStore,
    mcpTools: payload.mcpTools,
    model,
    modelId,
    bridgeKey,
    convKey,
    completedTurns: turns,
    currentTurn,
    writer,
    options,
    requestId,
    getAccessToken,
    recoverBeforeRetry: true,
    systemPrompt: effectiveSystemPrompt,
    conversationId: stored.conversationId,
    maxMode,
    cursorModelParameters: body.cursor_model_parameters ?? [],
  });
}

function writeNativeStream(
  bridge: BridgeHandle,
  heartbeatTimer: ReturnType<typeof setInterval>,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  _model: Model<Api>,
  modelId: string,
  bridgeKey: string,
  convKey: string,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
  writer: NativeStreamWriter,
  options?: CursorNativeStreamOptions,
  requestId?: string,
  idleRetry?: StreamIdleRetryController,
  streamIdleTimeoutMs = resolveStreamIdleTimeoutMs(process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS),
  checkpointRef: CheckpointRef = { current: null },
  preservedMidPauseExecs: PendingExec[] = [],
  clientTranscript: ClientTranscript = liveTranscript(completedTurns),
): void {
  const persistenceTurns = clientTranscript.completedTurns;
  debugLog("native.stream.start", {
    requestId,
    bridgeKey,
    convKey,
    modelId,
    attempt: idleRetry?.currentAttempt ?? 1,
    maxRetries: idleRetry?.maxRetries ?? 0,
  });
  lifecycleLog("stream_start", {
    requestId,
    bridgeKey: bridgeKeyPrefix(bridgeKey),
    convKey,
    modelId,
    attempt: idleRetry?.currentAttempt ?? 1,
  });
  const state: StreamState = {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    turnEnded: false,
  };
  const tagFilter = createThinkingTagFilter();
  let mcpExecReceived = false;
  let cancelled = false;
  let frameParseFailed = false;
  let streamError: Error | null = null;
  let emittedUserVisibleContent = false;
  // Only execs the client was actually told about may be recorded as pending: recovery matches the
  // snapshot against the tool results the client sends back, and it can only send back what it saw.
  const emittedExecs: PendingExec[] = [];
  // Cursor can emit several execs in one chunk. Closing the writer on the first would hide the
  // rest, so the pause is deferred until the whole chunk has been parsed.
  let pauseRequested = false;
  let cachedHistoryFingerprint: string | undefined;
  // Completed turns are fixed for the life of a stream, so this is hashed at most once.
  const historyFingerprint = () =>
    (cachedHistoryFingerprint ??= fingerprintCompletedTurns(completedTurns));
  const idleWatchdog = createStreamIdleWatchdog({
    timeoutMs: streamIdleTimeoutMs,
    onTimeout: () => {
      if (cancelled || writer.closed) return;
      cancelled = true;
      idleWatchdog.clear();
      const attempt = idleRetry?.currentAttempt ?? 1;
      const maxRetries = idleRetry?.maxRetries ?? 0;
      const restartContext: IdleRestartContext = {
        emittedUserVisibleContent,
        latestCheckpoint: checkpointRef.current,
        blobStore,
        completedTurns,
        currentTurn,
      };
      debugLog("native.stream.idle_timeout", {
        requestId,
        bridgeKey,
        convKey,
        modelId,
        timeoutMs: streamIdleTimeoutMs,
        attempt,
        maxRetries,
        emittedUserVisibleContent,
        hasCheckpoint: !!checkpointRef.current,
      });
      setLastIdleTimeout({
        timeoutMs: streamIdleTimeoutMs,
        attempt,
        event: "idle_timeout",
      });
      persistAbortedConversationState(
        convKey,
        checkpointRef.current,
        blobStore,
        persistenceTurns,
        currentTurn,
        emittedExecs.length > 0 ? emittedExecs : preservedMidPauseExecs,
      );
      cleanupBridge(bridge, heartbeatTimer, bridgeKey);
      options?.signal?.removeEventListener("abort", abort);

      // Blind restart is only safe with zero streamed content. Checkpoint
      // continuation is safe even after partial text: Cursor resumes server
      // state and emits only new tokens, which Pi appends to the writer.
      const allowRestart = canRecoverAfterTransportLoss({
        emittedUserVisibleContent,
        hasCheckpoint: !!checkpointRef.current,
      });

      // Recovery is not a retry, so it can run even when maxRetries is zero.
      if (idleRetry?.recoverBeforeRetry && allowRestart) {
        debugLog("native.stream.idle_recovery_before_retry", {
          requestId,
          bridgeKey,
          bridgeKeyPrefix: bridgeKeyPrefix(bridgeKey),
          convKey,
          modelId,
          attempt,
          maxRetries,
          hasCheckpoint: !!checkpointRef.current,
          emittedUserVisibleContent,
        });
        setLastStreamEvent("idle_recovery_before_retry");
        try {
          if (idleRetry.restart(attempt, restartContext)) return;
        } catch (error) {
          // Recovery errors fall through into the normal retry-budget path below.
          debugLog("native.stream.idle_recovery_before_retry_error", {
            requestId,
            bridgeKey,
            bridgeKeyPrefix: bridgeKeyPrefix(bridgeKey),
            convKey,
            modelId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      let finalAttempt = attempt;
      if (idleRetry && attempt <= maxRetries && allowRestart) {
        const nextAttempt = attempt + 1;
        finalAttempt = nextAttempt;
        debugLog("native.stream.idle_retry", {
          requestId,
          bridgeKey,
          convKey,
          modelId,
          attempt,
          nextAttempt,
          maxRetries,
          hasCheckpoint: !!checkpointRef.current,
          emittedUserVisibleContent,
        });
        setLastStreamEvent("idle_retry");
        try {
          if (idleRetry.restart(nextAttempt, restartContext)) return;
        } catch (error) {
          debugLog("native.stream.idle_retry_error", {
            requestId,
            bridgeKey,
            convKey,
            modelId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      writer.error(
        formatStreamIdleTimeoutMessage(
          streamIdleTimeoutMs,
          finalAttempt,
          maxRetries,
          emittedUserVisibleContent,
        ),
        "error",
        state,
      );
    },
  });

  const abort = () => {
    if (cancelled || writer.closed) return;
    cancelled = true;
    persistAbortedConversationState(
      convKey,
      checkpointRef.current,
      blobStore,
      persistenceTurns,
      currentTurn,
      emittedExecs.length > 0 ? emittedExecs : preservedMidPauseExecs,
    );
    debugLog("native.stream.abort", {
      requestId,
      bridgeKey,
      convKey,
      hasCheckpoint: !!checkpointRef.current,
    });
    idleWatchdog.clear();
    cleanupBridge(bridge, heartbeatTimer, bridgeKey);
    writer.error("Aborted", "aborted", state);
  };
  options?.signal?.addEventListener("abort", abort, { once: true });
  if (options?.signal?.aborted) {
    abort();
    return;
  }
  idleWatchdog.start();

  let streamFinalized = false;

  const emitText = (text: string, isThinking?: boolean) => {
    if (writer.closed) return;
    // A staged pause means the tool-call block is already on the response and `toolUse` is about to
    // close it. Text emitted now would land *after* that block, which breaks the invariant that a
    // tool-use turn ends on its tool call. Before the pause was deferred the closed writer dropped
    // this text anyway, so nothing regresses by dropping it explicitly.
    if (pauseRequested) return;
    if (isThinking) {
      emittedUserVisibleContent = true;
      writer.thinking(text);
      return;
    }
    const { content, reasoning } = tagFilter.process(text);
    if (reasoning) {
      emittedUserVisibleContent = true;
      writer.thinking(reasoning);
    }
    if (content) {
      emittedUserVisibleContent = true;
      appendAssistantTextToTurn(currentTurn, content);
      writer.text(content);
    }
  };

  const emitFlushed = () => {
    // Same ordering rule as emitText: once a tool-call block is on the response, nothing may be
    // appended after it. The first exec of a chunk flushes before staging its pause, so pending
    // text still reaches the client ahead of the tool call.
    if (pauseRequested) return;
    const flushed = tagFilter.flush();
    if (flushed.reasoning) {
      emittedUserVisibleContent = true;
      writer.thinking(flushed.reasoning);
    }
    if (flushed.content) {
      emittedUserVisibleContent = true;
      appendAssistantTextToTurn(currentTurn, flushed.content);
      writer.text(flushed.content);
    }
  };

  const finalizeSuccessfulStream = () => {
    if (cancelled || streamFinalized) return;
    streamFinalized = true;
    idleWatchdog.clear();
    clearInterval(heartbeatTimer);
    options?.signal?.removeEventListener("abort", abort);
    const stored = conversationStates.get(convKey);
    if (mcpExecReceived) {
      handleBridgeCloseMidPause({
        stored,
        latestCheckpoint: checkpointRef.current,
        blobStore,
        completedTurns: persistenceTurns,
        pendingExecs: emittedExecs,
        convKey,
      });
      removeActiveBridge(bridgeKey);
      return;
    }
    emitFlushed();
    if (stored) {
      if (checkpointRef.current) {
        commitStoredCheckpoint(
          stored,
          checkpointRef.current,
          blobStore,
          completedTurns,
          currentTurn,
          convKey,
        );
        debugLog("native.stream.checkpoint_committed", { requestId, convKey, stored });
      } else {
        mergeBlobStore(stored, blobStore);
      }
    }
    writer.done("stop", state);
    parkIdleBridge(bridgeKey, bridge);
  };
  bridge.onStreamDone?.(finalizeSuccessfulStream);

  const processChunk = createConnectFrameParser(
    (messageBytes) => {
      try {
        const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
        const madeProgress = processServerMessage(
          serverMessage,
          blobStore,
          mcpTools,
          (data) => bridge.write(data),
          state,
          emitText,
          (exec) => {
            idleWatchdog.pause();
            state.pendingExecs.push(exec);
            mcpExecReceived = true;
            emitFlushed();
            currentTurn.steps.push({
              kind: "toolCall",
              toolCallId: exec.toolCallId,
              toolName: exec.toolName,
              arguments: parseToolCallArguments(exec.decodedArgs),
            });

            // Emit before snapshotting: an exec the writer refuses is one the client will never
            // answer, so it must not be recorded as pending.
            if (!writer.closed) {
              writer.toolCall(exec);
              emittedExecs.push(exec);
              pauseRequested = true;
            }

            const stored = conversationStates.get(convKey);
            // Nothing reached the client, so there is no continuation to snapshot — and writing an
            // empty one here would clear a checkpoint this stream may still need.
            if (stored && emittedExecs.length > 0) {
              commitStoredCheckpointMidPause(
                stored,
                checkpointRef.current,
                blobStore,
                persistenceTurns,
                emittedExecs,
                convKey,
              );
              debugLog(
                checkpointRef.current
                  ? "native.stream.tool_call_checkpoint_saved"
                  : "native.stream.tool_call_snapshot_saved",
                {
                  requestId,
                  bridgeKey,
                  convKey,
                  checkpointSource: checkpointRef.current ? "upstream" : "absent",
                  pendingToolCallIds: emittedExecs.map((e) => e.toolCallId),
                },
              );
            }

            setActiveBridge(bridgeKey, {
              bridge,
              heartbeatTimer,
              blobStore,
              mcpTools,
              pendingExecs: state.pendingExecs,
              currentTurn,
              checkpointRef,
              state,
              historyFingerprint: historyFingerprint(),
              clientTranscript,
            });
            debugLog("native.stream.tool_call_pause", {
              requestId,
              bridgeKey,
              exec,
              pendingExecs: state.pendingExecs,
              emittedToolCallIds: emittedExecs.map((e) => e.toolCallId),
              currentTurn,
            });
          },
          (checkpointBytes) => {
            checkpointRef.current = checkpointBytes;
            debugLog("native.stream.checkpoint_buffered", { requestId, convKey, checkpointBytes });
          },
        );
        if (madeProgress) {
          idleWatchdog.reset();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog("native.stream.process_error", { requestId, message });
        if (!cancelled) {
          cancelled = true;
          idleWatchdog.clear();
          options?.signal?.removeEventListener("abort", abort);
          cleanupBridge(bridge, heartbeatTimer, bridgeKey);
          if (!writer.closed) writer.error(message, "error", state);
        }
      }
    },
    (endStreamBytes) => {
      const endError = parseConnectEndStream(endStreamBytes);
      if (endError) {
        // Cursor closes the connection right after `turnEnded`. That close ends a completed
        // turn; reporting it as an error made Pi retry and duplicate the answer (upstream #3).
        if (state.turnEnded && !pauseRequested) {
          debugLog("native.stream.post_turn_close", {
            requestId,
            modelId,
            message: endError.message,
          });
          return;
        }
        streamError = endError;
        const enhanced = enhanceCursorStreamError(endError.message);
        debugLog("native.stream.cursor_error", {
          requestId,
          modelId,
          message: endError.message,
          enhanced,
          isAuthError: isAuthErrorMessage(endError.message),
          deferredToToolPause: pauseRequested,
        });
        // A tool pause staged earlier in this same chunk wins: the client needs the tool call to
        // continue, and `streamError` still routes the close through mid-pause snapshotting so the
        // returning results land in recovery rather than on a bridge nobody is holding.
        if (!pauseRequested) writer.error(enhanced, "error", state);
      }
    },
  );

  bridge.onData((chunk) => {
    // Watchdog reset moved into the framed-message handler above so non-progress chunks
    // (notably `interactionUpdate{tokenDelta}`-only frames) cannot keep the stream alive
    // forever.
    try {
      processChunk(chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const desync =
        error instanceof Error
          ? (error as Error & { connectFrameDesync?: ConnectFrameDesyncDiagnostics })
              .connectFrameDesync
          : undefined;
      debugLog("native.stream.frame_error", { requestId, message, desync });
      // A corrupted/misaligned Connect frame boundary can't be recovered within this
      // connection, but the desync is local per-connection state, not a permanent condition —
      // killing the bridge (rather than failing the stream outright) routes this through the
      // same bridge.onClose retry path as any other transport loss (GOAWAY, ECONNRESET, ...),
      // so a fresh connection + checkpoint/history recovery can continue the turn instead of
      // the whole turn failing on what may be a one-off glitch.
      if (!cancelled && !frameParseFailed) {
        frameParseFailed = true;
        try {
          bridge.proc.kill();
        } catch {
          // Process may already be exiting.
        }
      }
      return;
    }
    // Closing the response is deferred to here so that every exec framed in this chunk reaches
    // the client, not just the first. Parallel tool calls arrive as sibling frames.
    if (pauseRequested) {
      pauseRequested = false;
      if (!writer.closed) writer.done("toolUse", state);
    }
  });

  bridge.onClose((code) => {
    debugLog("native.stream.bridge_close", {
      requestId,
      bridgeKey,
      convKey,
      code,
      cancelled,
      mcpExecReceived,
      streamFinalized,
      currentTurn,
      latestCheckpoint: checkpointRef.current,
    });
    lifecycleLog("bridge_close", {
      requestId,
      bridgeKey: bridgeKeyPrefix(bridgeKey),
      convKey,
      code,
      cancelled,
      mcpExecReceived,
      emittedUserVisibleContent,
      hasCheckpoint: !!checkpointRef.current,
    });
    if (streamFinalized) return;
    idleWatchdog.clear();
    clearInterval(heartbeatTimer);
    options?.signal?.removeEventListener("abort", abort);

    if (cancelled) return;
    const stored = conversationStates.get(convKey);
    if (streamError) {
      if (mcpExecReceived) {
        const midPauseResult = handleBridgeCloseMidPause({
          stored,
          latestCheckpoint: checkpointRef.current,
          blobStore,
          completedTurns: persistenceTurns,
          pendingExecs: emittedExecs,
          convKey,
        });
        debugLog(
          midPauseResult.committed
            ? "bridge.died_mid_pause_checkpoint_saved"
            : "bridge.died_mid_pause_no_checkpoint",
          {
            requestId,
            bridgeKey,
            convKey,
            cause: "stream_error",
            pendingToolCallIds: emittedExecs.map((e) => e.toolCallId),
          },
        );
      }
      removeActiveBridge(bridgeKey);
      return;
    }

    // Same completed-turn rule as the end-stream frame: the non-zero exit that follows a
    // GOAWAY after `turnEnded` must finalize the turn, not restart it (upstream #3).
    const completedTurnClose = state.turnEnded && !mcpExecReceived;

    if (code !== 0 && !completedTurnClose) {
      const failure = classifyBridgeExit({
        exitCode: code,
        stderr: typeof bridge.lastStderr === "function" ? bridge.lastStderr() : "",
      });
      const allowRestart =
        failure.retryable &&
        canRecoverAfterTransportLoss({
          emittedUserVisibleContent,
          hasCheckpoint: !!checkpointRef.current,
        });
      if (allowRestart && idleRetry) {
        const attempt = idleRetry.currentAttempt;
        const maxRetries = idleRetry.maxRetries;
        if (attempt <= maxRetries) {
          debugLog("native.stream.transport_retry", {
            requestId,
            bridgeKey,
            convKey,
            modelId,
            attempt,
            maxRetries,
            failureKind: failure.kind,
            hasCheckpoint: !!checkpointRef.current,
            emittedUserVisibleContent,
          });
          setLastStreamEvent(`transport_retry:${failure.kind}`);
          persistAbortedConversationState(
            convKey,
            checkpointRef.current,
            blobStore,
            persistenceTurns,
            currentTurn,
            emittedExecs.length > 0 ? emittedExecs : preservedMidPauseExecs,
          );
          cleanupBridge(bridge, heartbeatTimer, bridgeKey);
          options?.signal?.removeEventListener("abort", abort);
          try {
            if (
              idleRetry.restart(attempt + 1, {
                emittedUserVisibleContent,
                latestCheckpoint: checkpointRef.current,
                blobStore,
                completedTurns,
                currentTurn,
              })
            )
              return;
          } catch {
            // Fall through to error
          }
        }
      }
      if (mcpExecReceived) {
        const midPauseResult = handleBridgeCloseMidPause({
          stored,
          latestCheckpoint: checkpointRef.current,
          blobStore,
          completedTurns: persistenceTurns,
          pendingExecs: emittedExecs,
          convKey,
        });
        debugLog(
          midPauseResult.committed
            ? "bridge.died_mid_pause_checkpoint_saved"
            : "bridge.died_mid_pause_no_checkpoint",
          {
            requestId,
            bridgeKey,
            convKey,
            code,
            failureKind: failure.kind,
            pendingToolCallIds: emittedExecs.map((e) => e.toolCallId),
          },
        );
      }
      writer.error(formatTransportFailure(failure), "error", state);
      removeActiveBridge(bridgeKey);
      return;
    }

    if (!mcpExecReceived) {
      emitFlushed();
      if (stored) {
        if (checkpointRef.current) {
          commitStoredCheckpoint(
            stored,
            checkpointRef.current,
            blobStore,
            completedTurns,
            currentTurn,
            convKey,
          );
          debugLog("native.stream.checkpoint_committed", { requestId, convKey, stored });
        } else {
          mergeBlobStore(stored, blobStore);
        }
      }
      writer.done("stop", state);
    } else {
      const midPauseResult = handleBridgeCloseMidPause({
        stored,
        latestCheckpoint: checkpointRef.current,
        blobStore,
        completedTurns: persistenceTurns,
        pendingExecs: emittedExecs,
        convKey,
      });
      debugLog(
        midPauseResult.committed
          ? "bridge.died_mid_pause_checkpoint_saved"
          : "bridge.died_mid_pause_no_checkpoint",
        {
          requestId,
          bridgeKey,
          convKey,
          pendingToolCallIds: emittedExecs.map((e) => e.toolCallId),
        },
      );
      removeActiveBridge(bridgeKey);
    }
  });
}

interface ResumeContext {
  accessToken: string;
  systemPrompt: string;
  model: Model<Api>;
  modelId: string;
  bridgeKey: string;
  convKey: string;
  sessionId: string | undefined;
  completedTurns: ParsedTurn[];
  /** Pi's in-flight turn from the resume request, not the bridge's currentTurn suffix. */
  inFlightTurn?: ParsedTurn;
  maxMode: boolean;
  cursorModelParameters: CursorModelParameter[];
  getAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string>;
}

function handleNativeToolResultResume(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  ctx: ResumeContext,
  writer: NativeStreamWriter,
  options?: CursorNativeStreamOptions,
  requestId?: string,
): void {
  const {
    accessToken,
    systemPrompt,
    model,
    modelId,
    bridgeKey,
    convKey,
    sessionId,
    completedTurns,
    maxMode,
    cursorModelParameters,
    getAccessToken,
  } = ctx;
  const {
    bridge,
    heartbeatTimer,
    blobStore,
    mcpTools,
    pendingExecs,
    currentTurn,
    checkpointRef,
    state: pausedState,
    historyFingerprint,
    clientTranscript: parkedTranscript,
  } = active;
  const resumeTranscript = parkedTranscript ?? liveTranscript(completedTurns);
  const recoveredClientTranscript = withSyntheticCurrentTurn(
    resumeTranscript,
    ctx.inFlightTurn ?? currentTurn,
  );
  const resumeIdleTimeoutMs = resolveResumeIdleTimeoutMs(
    process.env.PI_CURSOR_RESUME_IDLE_TIMEOUT_MS,
  );
  const transportResults = toolResults.map((result) => ({
    ...result,
    ...normalizeToolResultForTransport(result),
  }));
  debugLog("native.tool_resume.start", {
    requestId,
    bridgeKey,
    convKey,
    toolResults: transportResults.map((result) => ({
      toolCallId: result.toolCallId,
      contentBytes: Buffer.byteLength(result.content, "utf8"),
      imageCount: result.images?.length ?? 0,
      imageBytes: result.images?.reduce((sum, image) => sum + image.data.byteLength, 0) ?? 0,
      isError: result.isError === true,
    })),
    pendingExecs,
    currentTurn,
  });

  for (const result of transportResults) {
    const turnToolStep = currentTurn.steps.find(
      (step): step is ParsedToolCallStep =>
        step.kind === "toolCall" && step.toolCallId === result.toolCallId,
    );
    if (turnToolStep) {
      turnToolStep.result = {
        content: result.content,
        images: result.images,
        isError: result.isError === true,
      };
    }
  }

  const turnResults = getTurnToolCallResults(currentTurn);
  const unresolvedExecs = pendingExecs.filter((exec) => !turnResults.has(exec.toolCallId));
  if (unresolvedExecs.length > 0) {
    setActiveBridge(bridgeKey, {
      bridge,
      heartbeatTimer,
      blobStore,
      mcpTools,
      pendingExecs,
      currentTurn,
      checkpointRef,
      state: pausedState,
      historyFingerprint,
    });
    debugLog("native.tool_resume.partial_wait", {
      requestId,
      bridgeKey,
      unresolvedExecs,
      currentTurn,
    });
    // Re-emitting here is the only way the client learns about execs that arrived after its
    // response closed, so the snapshot has to grow with them.
    const stored = conversationStates.get(convKey);
    if (stored) {
      commitStoredCheckpointMidPause(
        stored,
        checkpointRef.current,
        blobStore,
        completedTurns,
        [...pendingExecs],
        convKey,
      );
    }
    for (const exec of unresolvedExecs) writer.toolCall(exec);
    writer.done("toolUse", pausedState);
    return;
  }

  for (const exec of pendingExecs) {
    const result = turnResults.get(exec.toolCallId);
    if (!result) continue;
    const mcpResult = create(McpResultSchema, {
      result: {
        case: "success",
        value: create(McpSuccessSchema, {
          content: buildMcpSuccessContent(result),
          isError: result.isError === true,
        }),
      },
    });

    const execClientMessage = create(ExecClientMessageSchema, {
      id: exec.execMsgId,
      execId: exec.execId,
      message: { case: "mcpResult" as any, value: mcpResult as any },
    });
    const clientMessage = create(AgentClientMessageSchema, {
      message: { case: "execClientMessage", value: execClientMessage },
    });
    bridge.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
    debugLog("native.tool_resume.sent_result", {
      requestId,
      exec,
      contentBytes: Buffer.byteLength(result.content, "utf8"),
      imageCount: result.images?.length ?? 0,
    });
  }

  const idleRetry: StreamIdleRetryController = {
    currentAttempt: 1,
    maxRetries: resolveStreamIdleMaxRetries(process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES),
    // Phase 0 found mcpArgs-before-checkpoint across composer/gemini/gpt-5.4, so this stays model-agnostic.
    recoverBeforeRetry: true,
    restart(nextAttempt: number, _context: IdleRestartContext) {
      idleRetry.currentAttempt = nextAttempt;
      const stored = conversationStates.get(convKey);
      const decision = planRecovery({
        stored,
        toolResults,
        completedTurns,
        inFlightTurn: stripInFlightResults(ctx.inFlightTurn ?? currentTurn),
        rebuildReason: "synthesized_after_idle",
        sessionId,
        requestId: requestId ?? "native-tool-idle-retry",
        convKey,
      });
      if (decision.kind === "rebuild_full_history") {
        setLastStreamEvent("rebuild_full_history");
        logFullHistoryRebuild("native.rebuild_full_history", {
          requestId,
          bridgeKey,
          convKey,
          modelId,
          decision,
        });
        const rebuiltCompletedTurns = [...decision.completedTurns, decision.inFlightTurn];
        const recoveredUserImages = collectToolResultImages(decision.toolResults);
        const recoveredCurrentTurn: ParsedTurn = {
          userText: decision.wrappedText,
          steps: [],
          ...(recoveredUserImages.length ? { userImages: recoveredUserImages } : {}),
        };
        const payload = buildCursorRequest({
          modelId,
          systemPrompt,
          userText: decision.wrappedText,
          userImages: recoveredUserImages,
          turns: rebuiltCompletedTurns,
          conversationId: decision.conversationId,
          checkpoint: null,
          existingBlobStore: decision.blobStore,
          maxMode,
          cursorModelParameters,
          mcpTools,
        });
        payload.mcpTools = mcpTools;
        if (stored) stored.lastAccessMs = Date.now();
        startNativeStreamWithIdleRetries({
          accessToken,
          requestBytes: payload.requestBytes,
          blobStore: payload.blobStore,
          mcpTools: payload.mcpTools,
          model,
          modelId,
          bridgeKey,
          convKey,
          completedTurns: rebuiltCompletedTurns,
          currentTurn: recoveredCurrentTurn,
          clientTranscript: recoveredClientTranscript,
          writer,
          options,
          requestId,
          maxIdleRetries: idleRetry.maxRetries,
          streamIdleTimeoutMs: resumeIdleTimeoutMs,
          getAccessToken,
          systemPrompt,
          conversationId: decision.conversationId,
          maxMode,
          cursorModelParameters,
        });
        return true;
      }
      if (decision.kind !== "recover") {
        debugLog("native.tool_resume.idle_retry_recovery_skipped", {
          requestId,
          bridgeKey,
          bridgeKeyPrefix: bridgeKeyPrefix(bridgeKey),
          convKey,
          skipReason: decision.reason,
          hadStoredCheckpoint: decision.hadStoredCheckpoint,
          ...(decision.expected !== undefined ? { expected: decision.expected } : {}),
          ...(decision.received !== undefined ? { received: decision.received } : {}),
        });
        writer.error(
          `${lostToolContinuationMessage()} ${formatLostToolContinuationDiagnostic({
            bridgeKey,
            hadStoredCheckpoint: decision.hadStoredCheckpoint,
            skipReason: decision.reason,
          })}`,
          "error",
        );
        return true;
      }

      debugLog("native.tool_resume.idle_retry_recover", {
        requestId,
        bridgeKey,
        bridgeKeyPrefix: bridgeKeyPrefix(bridgeKey),
        convKey,
        recoveryPath: "stored_checkpoint",
        attempt: nextAttempt,
        pendingToolCallIds: toolResults.map((r) => r.toolCallId),
      });
      const recoveredUserImages = collectToolResultImages(toolResults);
      const recoveredCurrentTurn: ParsedTurn = {
        userText: decision.wrappedText,
        steps: [],
        ...(recoveredUserImages.length ? { userImages: recoveredUserImages } : {}),
      };
      const payload = buildCursorRequest({
        modelId,
        systemPrompt,
        userText: decision.wrappedText,
        userImages: recoveredUserImages,
        turns: completedTurns,
        conversationId: decision.conversationId,
        checkpoint: decision.checkpoint,
        existingBlobStore: decision.blobStore,
        maxMode,
        cursorModelParameters,
        mcpTools,
      });
      payload.mcpTools = mcpTools;
      startNativeStreamWithIdleRetries({
        accessToken,
        requestBytes: payload.requestBytes,
        blobStore: payload.blobStore,
        mcpTools: payload.mcpTools,
        model,
        modelId,
        bridgeKey,
        convKey,
        completedTurns,
        currentTurn: recoveredCurrentTurn,
        clientTranscript: recoveredClientTranscript,
        writer,
        options,
        requestId,
        maxIdleRetries: idleRetry.maxRetries,
        streamIdleTimeoutMs: resumeIdleTimeoutMs,
        getAccessToken,
        systemPrompt,
        conversationId: decision.conversationId,
        maxMode,
        cursorModelParameters,
      });
      return true;
    },
  };

  writeNativeStream(
    bridge,
    heartbeatTimer,
    blobStore,
    mcpTools,
    model,
    modelId,
    bridgeKey,
    convKey,
    completedTurns,
    currentTurn,
    writer,
    options,
    requestId,
    idleRetry,
    resumeIdleTimeoutMs,
    // Same bridge, so the same checkpoint cell: frames that landed during the pause stay visible.
    checkpointRef,
    // A timeout after Cursor receives the tool result still needs the original pause
    // snapshot so recovery can safely recreate that continuation.
    pendingExecs,
    resumeTranscript,
  );
}

// ── Request handling ──

export type ResolvedCursorModelRouting = ExtractedResolvedCursorModelRouting;
export type CursorResolvableModel = ExtractedCursorResolvableModel;

export function resolveModelId(model: string, reasoningEffort?: string): string {
  return resolveModelIdImpl(model, reasoningEffort);
}

export function resolveRequestedModelId(
  model: string,
  reasoningEffort?: string,
  cursorModelId?: string,
): string;
export function resolveRequestedModelId(
  model: CursorResolvableModel,
  reasoningEffort?: string,
  routingByModelId?: Map<
    string,
    Record<string, CursorNativeModelRouting> | CursorNativeModelRouting
  >,
): ResolvedCursorModelRouting;
export function resolveRequestedModelId(
  model: string | CursorResolvableModel,
  reasoningEffort?: string,
  cursorModelIdOrRoutingByModelId?:
    string | Map<string, Record<string, CursorNativeModelRouting> | CursorNativeModelRouting>,
): string | ResolvedCursorModelRouting {
  return resolveRequestedModelIdImpl(
    model as any,
    reasoningEffort,
    cursorModelIdOrRoutingByModelId as any,
  );
}

// ── Streaming response ──

function formatStreamIdleTimeoutMessage(
  timeoutMs: number,
  attempt: number,
  maxRetries: number,
  emittedUserVisibleContent = false,
): string {
  const base = `Cursor stream idle timeout after ${timeoutMs}ms without upstream progress`;
  const attemptLabel = attempt === 1 ? "attempt" : "attempts";
  const retryLabel = maxRetries === 1 ? "retry" : "retries";
  const retryPart =
    maxRetries > 0 ? ` over ${attempt} ${attemptLabel} (${maxRetries} ${retryLabel})` : "";
  const partialPart = emittedUserVisibleContent
    ? " Partial assistant output was already streamed; automatic retry requires a checkpoint and was unavailable or exhausted."
    : "";
  const tunePart =
    " Tune PI_CURSOR_STREAM_IDLE_TIMEOUT_MS / PI_CURSOR_RESUME_IDLE_TIMEOUT_MS if long reasoning turns are expected.";
  return `${base}${retryPart}.${partialPart}${tunePart}`;
}

function startNativeStreamWithIdleRetries(input: NativeStreamAttemptInput): void {
  // Recovered/rebuilt streams enter this helper with ordinary retry semantics to avoid recursive recovery loops.
  let latestAccessToken = input.accessToken;
  // Mutable across generations so checkpoint continuation can replace the original request body.
  let requestBytes = input.requestBytes;
  let blobStore = input.blobStore;
  let completedTurns = input.completedTurns;
  let currentTurn = input.currentTurn;

  const controller: StreamIdleRetryController = {
    currentAttempt: 1,
    maxRetries:
      input.maxIdleRetries ??
      resolveStreamIdleMaxRetries(process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES),
    // Default on: transport loss after partial output can still continue via checkpoint.
    recoverBeforeRetry: input.recoverBeforeRetry ?? true,
    restart(nextAttempt: number, context: IdleRestartContext) {
      controller.currentAttempt = nextAttempt;
      debugLog(
        nextAttempt === 1 ? "native.stream.attempt_start" : "native.stream.idle_retry_start",
        {
          requestId: input.requestId,
          bridgeKey: input.bridgeKey,
          convKey: input.convKey,
          modelId: input.modelId,
          attempt: nextAttempt,
          maxRetries: controller.maxRetries,
          hasCheckpoint: !!context.latestCheckpoint,
          emittedUserVisibleContent: context.emittedUserVisibleContent,
        },
      );

      // After the first attempt, prefer checkpoint continuation when available so we do not
      // blind-replay a request that already produced partial assistant output.
      if (
        nextAttempt > 1 &&
        context.latestCheckpoint &&
        typeof input.systemPrompt === "string" &&
        input.conversationId
      ) {
        try {
          const continueText = CHECKPOINT_CONTINUATION_PROMPT;
          const payload = buildCursorRequest({
            modelId: input.modelId,
            systemPrompt: input.systemPrompt,
            userText: continueText,
            turns: context.completedTurns,
            conversationId: input.conversationId,
            checkpoint: context.latestCheckpoint,
            existingBlobStore: context.blobStore,
            maxMode: input.maxMode ?? false,
            cursorModelParameters: input.cursorModelParameters ?? [],
            mcpTools: input.mcpTools,
          });
          requestBytes = payload.requestBytes;
          blobStore = payload.blobStore;
          completedTurns = context.completedTurns;
          currentTurn = { userText: continueText, steps: [] };
          const stored = conversationStates.get(input.convKey);
          if (stored) {
            commitStoredCheckpoint(
              stored,
              context.latestCheckpoint,
              context.blobStore,
              context.completedTurns,
              context.currentTurn,
              input.convKey,
            );
          }
          setLastStreamEvent("checkpoint_continuation");
          debugLog("native.stream.checkpoint_continuation", {
            requestId: input.requestId,
            bridgeKey: input.bridgeKey,
            convKey: input.convKey,
            attempt: nextAttempt,
          });
        } catch (error) {
          debugLog("native.stream.checkpoint_continuation_failed", {
            requestId: input.requestId,
            message: error instanceof Error ? error.message : String(error),
          });
          // Fall back to the previous request bytes only when no user-visible content was emitted.
          if (context.emittedUserVisibleContent) return false;
        }
      } else if (nextAttempt > 1 && context.emittedUserVisibleContent) {
        // No checkpoint and partial output: cannot safely restart.
        return false;
      }

      const launch = (accessToken: string) => {
        latestAccessToken = accessToken;
        const { bridge, heartbeatTimer } = startBridge(accessToken, requestBytes, {
          bridgeKey: input.bridgeKey,
        });
        writeNativeStream(
          bridge,
          heartbeatTimer,
          blobStore,
          input.mcpTools,
          input.model,
          input.modelId,
          input.bridgeKey,
          input.convKey,
          completedTurns,
          currentTurn,
          input.writer,
          input.options,
          input.requestId,
          controller,
          input.streamIdleTimeoutMs,
          { current: null },
          [],
          input.clientTranscript ?? liveTranscript(completedTurns),
        );
      };

      // First attempt is synchronous. Later attempts force-refresh credentials when possible.
      if (nextAttempt === 1 || !input.getAccessToken) {
        launch(latestAccessToken);
        return true;
      }

      void input
        .getAccessToken({ forceRefresh: true })
        .then((token) => {
          if (input.writer.closed) return;
          setLastStreamEvent("idle_retry_token_refreshed");
          launch(token);
        })
        .catch((error) => {
          debugLog("native.stream.idle_retry_token_refresh_failed", {
            requestId: input.requestId,
            message: error instanceof Error ? error.message : String(error),
          });
          if (input.writer.closed) return;
          // Fall back to the previous token rather than hard-failing immediately.
          launch(latestAccessToken);
        });
      return true;
    },
  };
  controller.restart(1, {
    emittedUserVisibleContent: false,
    latestCheckpoint: null,
    blobStore: input.blobStore,
    completedTurns: input.completedTurns,
    currentTurn: input.currentTurn,
  });
}
