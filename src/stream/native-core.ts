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
  applyCursorUsage,
  contextToCursorChatCompletionRequest,
  createCursorAssistantMessage,
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
} from "./request-build.js";
export { buildCursorRequest, type BuildCursorRequestOptions } from "./request-build.js";
import {
  appendAssistantTextToTurn,
  getTurnToolCallResults,
  parseMessages,
  parseToolCallArguments,
  stripInFlightResults,
} from "./message-parsing.js";
export {
  frameContextModeSideChannel,
  isContextModeSideChannelText,
  normalizeMessagesForCursor,
  parseMessages,
} from "./message-parsing.js";
export {
  callCursorUnaryRpc,
  getCursorModels,
  getCursorParameterizedModels,
  inferCursorContextWindow,
  type CursorModel,
} from "./model-discovery.js";
import {
  activeBridges,
  cleanupBridge,
  removeActiveBridge,
  setActiveBridge,
  startBridge,
} from "./bridge-session.js";
export { setBridgeFactoryForTests } from "./bridge-session.js";
import {
  canBlindIdleRestart,
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
  interactionUpdateCountsAsProgress,
  resolveActiveBridgeTtlMs,
  resolveH2ConnectTimeoutMs,
  resolveH2IdleTimeoutMs,
  resolveResumeIdleTimeoutMs,
  resolveStreamIdleMaxRetries,
  resolveStreamIdleTimeoutMs,
} from "./tuning.js";
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
import {
  planRecovery as planRecoveryImpl,
  wrapRecoveredToolResults as wrapRecoveredToolResultsImpl,
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
  CursorNativeStreamConfig,
  CursorNativeStreamOptions,
  IdleRestartContext,
  NativeBlockKind,
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
  clearStoredMidPauseMetadata,
  collectToolResultImages,
  debugBase64ImageSummary,
  decodeRequestForTests,
  discardStaleCheckpointIfNeeded,
  fingerprintCompletedTurns,
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
  setMetricEmitterForTests(factory?: MetricEmitter) {
    setMetricEmitter(factory);
  },
};

// ── Native pi streamSimple provider ──

export type CursorNativeModelRouting = ExtractedCursorNativeModelRouting;

function createNativeStreamWriter(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
): NativeStreamWriter {
  const output = createCursorAssistantMessage(model);
  let started = false;
  let closed = false;
  let active: { kind: NativeBlockKind; contentIndex: number; ended: boolean } | undefined;

  const ensureStarted = () => {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial: output });
  };

  const endActiveBlock = () => {
    if (!active || active.ended) return;
    const block = output.content[active.contentIndex];
    if (active.kind === "text" && block?.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: active.contentIndex,
        content: block.text,
        partial: output,
      });
    } else if (active.kind === "thinking" && block?.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: active.contentIndex,
        content: block.thinking,
        partial: output,
      });
    }
    active.ended = true;
    active = undefined;
  };

  const ensureBlock = (kind: NativeBlockKind): number => {
    ensureStarted();
    if (active?.kind === kind && !active.ended) return active.contentIndex;
    endActiveBlock();
    const contentIndex = output.content.length;
    if (kind === "text") {
      output.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex, partial: output });
    } else {
      output.content.push({ type: "thinking", thinking: "" });
      stream.push({ type: "thinking_start", contentIndex, partial: output });
    }
    active = { kind, contentIndex, ended: false };
    return contentIndex;
  };

  return {
    output,
    get closed() {
      return closed;
    },
    start: ensureStarted,
    text(delta: string) {
      if (closed || !delta) return;
      const contentIndex = ensureBlock("text");
      const block = output.content[contentIndex];
      if (block?.type !== "text") return;
      block.text += delta;
      stream.push({ type: "text_delta", contentIndex, delta, partial: output });
    },
    thinking(delta: string) {
      if (closed || !delta) return;
      const contentIndex = ensureBlock("thinking");
      const block = output.content[contentIndex];
      if (block?.type !== "thinking") return;
      block.thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
    },
    toolCall(exec: PendingExec) {
      if (closed) return;
      ensureStarted();
      endActiveBlock();
      const contentIndex = output.content.length;
      const parsedArguments = parseToolCallArguments(exec.decodedArgs);
      const block = {
        type: "toolCall" as const,
        id: exec.toolCallId,
        name: exec.toolName,
        arguments: {},
      };
      output.content.push(block);
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      block.arguments = parsedArguments;
      stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta: exec.decodedArgs,
        partial: output,
      });
      stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: {
          type: "toolCall",
          id: exec.toolCallId,
          name: exec.toolName,
          arguments: parsedArguments,
        },
        partial: output,
      });
    },
    done(reason: "stop" | "length" | "toolUse", state?: StreamState) {
      if (closed) return;
      ensureStarted();
      endActiveBlock();
      applyCursorUsage(output, model, state);
      output.stopReason = reason;
      stream.push({ type: "done", reason, message: output });
      closed = true;
      stream.end(output);
    },
    error(message: string, reason: "error" | "aborted", state?: StreamState) {
      if (closed) return;
      ensureStarted();
      endActiveBlock();
      applyCursorUsage(output, model, state);
      output.stopReason = reason;
      output.errorMessage = message;
      stream.push({ type: "error", reason, error: output });
      closed = true;
      stream.end(output);
    },
  };
}

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
  return toolResults.flatMap((result) => (result.images ?? []).map(cloneParsedImage));
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
      if (activeBridge.bridge.alive) {
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
    const recoveryStored = conversationStates.get(convKey);
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
      const mcpTools = buildMcpToolDefinitions(toolResolution.tools);
      const recoveredCurrentTurn: ParsedTurn = {
        userText: decision.wrappedText,
        steps: [],
      };
      const payload = buildCursorRequest({
        modelId,
        systemPrompt,
        userText: decision.wrappedText,
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
      const mcpTools = buildMcpToolDefinitions(toolResolution.tools);
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

  let stored = conversationStates.get(convKey);
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

  const mcpTools = buildMcpToolDefinitions(toolResolution.tools);
  const effectiveUserText = userText;
  const effectiveUserImages = userText || userImages.length > 0 ? userImages : [];
  const payload = buildCursorRequest(
    modelId,
    systemPrompt,
    effectiveUserText,
    turns,
    stored.conversationId,
    stored.checkpoint,
    stored.blobStore,
    maxMode,
    body.cursor_model_parameters,
    mcpTools,
    effectiveUserImages,
  );
  payload.mcpTools = mcpTools;

  const currentTurn: ParsedTurn = {
    userText: effectiveUserText,
    steps: [],
    ...(effectiveUserImages.length > 0 ? { userImages: effectiveUserImages } : {}),
  };

  debugLog("native.dispatch_stream", {
    requestId,
    bridgeKey,
    convKey,
    conversationId: stored.conversationId,
    hasCheckpoint: !!stored.checkpoint,
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
): void {
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
  };
  const tagFilter = createThinkingTagFilter();
  let mcpExecReceived = false;
  let cancelled = false;
  let streamError: Error | null = null;
  let latestCheckpoint: Uint8Array | null = null;
  let emittedUserVisibleContent = false;
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
        latestCheckpoint,
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
        hasCheckpoint: !!latestCheckpoint,
      });
      setLastIdleTimeout({
        timeoutMs: streamIdleTimeoutMs,
        attempt,
        event: "idle_timeout",
      });
      persistAbortedConversationState(
        convKey,
        latestCheckpoint,
        blobStore,
        completedTurns,
        currentTurn,
      );
      cleanupBridge(bridge, heartbeatTimer, bridgeKey);
      options?.signal?.removeEventListener("abort", abort);

      // Never blind-restart onto a writer that already has text/thinking — that
      // duplicates partial output and looks like "lost context".
      const allowBlindRestart = canBlindIdleRestart(emittedUserVisibleContent);

      // Recovery is not a retry, so it can run even when maxRetries is zero.
      // Still blocked when user-visible content is already on the writer.
      if (idleRetry?.recoverBeforeRetry && allowBlindRestart) {
        debugLog("native.stream.idle_recovery_before_retry", {
          requestId,
          bridgeKey,
          bridgeKeyPrefix: bridgeKeyPrefix(bridgeKey),
          convKey,
          modelId,
          attempt,
          maxRetries,
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
      if (idleRetry && attempt <= maxRetries && allowBlindRestart) {
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
      latestCheckpoint,
      blobStore,
      completedTurns,
      currentTurn,
    );
    debugLog("native.stream.abort", {
      requestId,
      bridgeKey,
      convKey,
      hasCheckpoint: !!latestCheckpoint,
    });
    idleWatchdog.clear();
    cleanupBridge(bridge, heartbeatTimer, bridgeKey);
    writer.error("Aborted", "aborted", state);
  };
  options?.signal?.addEventListener("abort", abort, { once: true });
  idleWatchdog.start();

  const emitText = (text: string, isThinking?: boolean) => {
    if (writer.closed) return;
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
            const stored = conversationStates.get(convKey);
            if (stored) {
              commitStoredCheckpointMidPause(
                stored,
                latestCheckpoint,
                blobStore,
                completedTurns,
                state.pendingExecs,
              );
              debugLog(
                latestCheckpoint
                  ? "native.stream.tool_call_checkpoint_saved"
                  : "native.stream.tool_call_snapshot_saved",
                {
                  requestId,
                  bridgeKey,
                  convKey,
                  checkpointSource: latestCheckpoint ? "upstream" : "absent",
                  pendingToolCallIds: state.pendingExecs.map((e) => e.toolCallId),
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
            });
            debugLog("native.stream.tool_call_pause", {
              requestId,
              bridgeKey,
              exec,
              pendingExecs: state.pendingExecs,
              currentTurn,
            });

            if (!writer.closed) {
              writer.toolCall(exec);
              writer.done("toolUse", state);
            }
          },
          (checkpointBytes) => {
            latestCheckpoint = checkpointBytes;
            debugLog("native.stream.checkpoint_buffered", { requestId, convKey, checkpointBytes });
          },
        );
        if (madeProgress) {
          idleWatchdog.reset();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog("native.stream.process_error", { requestId, message });
        if (!writer.closed) writer.error(message, "error", state);
      }
    },
    (endStreamBytes) => {
      const endError = parseConnectEndStream(endStreamBytes);
      if (endError) {
        streamError = endError;
        const enhanced = enhanceCursorStreamError(endError.message);
        debugLog("native.stream.cursor_error", {
          requestId,
          modelId,
          message: endError.message,
          enhanced,
          isAuthError: isAuthErrorMessage(endError.message),
        });
        writer.error(enhanced, "error", state);
      }
    },
  );

  bridge.onData((chunk) => {
    // Watchdog reset moved into the framed-message handler above so non-progress chunks
    // (notably `interactionUpdate{tokenDelta}`-only frames) cannot keep the stream alive
    // forever.
    processChunk(chunk);
  });

  bridge.onClose((code) => {
    debugLog("native.stream.bridge_close", {
      requestId,
      bridgeKey,
      convKey,
      code,
      cancelled,
      mcpExecReceived,
      currentTurn,
      latestCheckpoint,
    });
    lifecycleLog("bridge_close", {
      requestId,
      bridgeKey: bridgeKeyPrefix(bridgeKey),
      convKey,
      code,
      cancelled,
      mcpExecReceived,
      emittedUserVisibleContent,
      hasCheckpoint: !!latestCheckpoint,
    });
    idleWatchdog.clear();
    clearInterval(heartbeatTimer);
    options?.signal?.removeEventListener("abort", abort);

    if (cancelled) return;
    const stored = conversationStates.get(convKey);
    if (streamError) {
      if (mcpExecReceived) {
        const midPauseResult = handleBridgeCloseMidPause({
          stored,
          latestCheckpoint,
          blobStore,
          completedTurns,
          pendingExecs: state.pendingExecs,
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
            pendingToolCallIds: state.pendingExecs.map((e) => e.toolCallId),
          },
        );
      }
      removeActiveBridge(bridgeKey);
      return;
    }

    if (code !== 0) {
      if (mcpExecReceived) {
        const midPauseResult = handleBridgeCloseMidPause({
          stored,
          latestCheckpoint,
          blobStore,
          completedTurns,
          pendingExecs: state.pendingExecs,
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
            pendingToolCallIds: state.pendingExecs.map((e) => e.toolCallId),
          },
        );
      }
      writer.error("Bridge connection lost", "error", state);
      removeActiveBridge(bridgeKey);
      return;
    }

    if (!mcpExecReceived) {
      emitFlushed();
      if (stored) {
        if (latestCheckpoint) {
          commitStoredCheckpoint(stored, latestCheckpoint, blobStore, completedTurns, currentTurn);
          debugLog("native.stream.checkpoint_committed", { requestId, convKey, stored });
        } else {
          mergeBlobStore(stored, blobStore);
        }
      }
      writer.done("stop", state);
    } else {
      const midPauseResult = handleBridgeCloseMidPause({
        stored,
        latestCheckpoint,
        blobStore,
        completedTurns,
        pendingExecs: state.pendingExecs,
      });
      debugLog(
        midPauseResult.committed
          ? "bridge.died_mid_pause_checkpoint_saved"
          : "bridge.died_mid_pause_no_checkpoint",
        {
          requestId,
          bridgeKey,
          convKey,
          pendingToolCallIds: state.pendingExecs.map((e) => e.toolCallId),
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
  const { bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs, currentTurn } = active;
  const resumeIdleTimeoutMs = resolveResumeIdleTimeoutMs(
    process.env.PI_CURSOR_RESUME_IDLE_TIMEOUT_MS,
  );
  debugLog("native.tool_resume.start", {
    requestId,
    bridgeKey,
    convKey,
    toolResults,
    pendingExecs,
    currentTurn,
  });

  for (const result of toolResults) {
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
    });
    debugLog("native.tool_resume.partial_wait", {
      requestId,
      bridgeKey,
      unresolvedExecs,
      currentTurn,
    });
    for (const exec of unresolvedExecs) writer.toolCall(exec);
    writer.done("toolUse");
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
    debugLog("native.tool_resume.sent_result", { requestId, exec, result });
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
        inFlightTurn: stripInFlightResults(currentTurn),
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
          writer,
          options,
          requestId,
          maxIdleRetries: idleRetry.maxRetries,
          streamIdleTimeoutMs: resumeIdleTimeoutMs,
          getAccessToken,
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
      const recoveredCurrentTurn: ParsedTurn = {
        userText: decision.wrappedText,
        steps: [],
      };
      const payload = buildCursorRequest(
        modelId,
        systemPrompt,
        decision.wrappedText,
        completedTurns,
        decision.conversationId,
        decision.checkpoint,
        decision.blobStore,
        maxMode,
        cursorModelParameters,
        mcpTools,
      );
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
        writer,
        options,
        requestId,
        maxIdleRetries: idleRetry.maxRetries,
        streamIdleTimeoutMs: resumeIdleTimeoutMs,
        getAccessToken,
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
    ? " Partial assistant output was already streamed, so an automatic retry was skipped to avoid duplicated text."
    : "";
  const tunePart =
    " Tune PI_CURSOR_STREAM_IDLE_TIMEOUT_MS / PI_CURSOR_RESUME_IDLE_TIMEOUT_MS if long reasoning turns are expected.";
  return `${base}${retryPart}.${partialPart}${tunePart}`;
}

function startNativeStreamWithIdleRetries(input: NativeStreamAttemptInput): void {
  // Recovered/rebuilt streams enter this helper with ordinary retry semantics to avoid recursive recovery loops.
  let latestAccessToken = input.accessToken;
  const controller: StreamIdleRetryController = {
    currentAttempt: 1,
    maxRetries:
      input.maxIdleRetries ??
      resolveStreamIdleMaxRetries(process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES),
    recoverBeforeRetry: input.recoverBeforeRetry,
    restart(nextAttempt: number, _context: IdleRestartContext) {
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
        },
      );

      const launch = (accessToken: string) => {
        latestAccessToken = accessToken;
        const { bridge, heartbeatTimer } = startBridge(accessToken, input.requestBytes);
        writeNativeStream(
          bridge,
          heartbeatTimer,
          input.blobStore,
          input.mcpTools,
          input.model,
          input.modelId,
          input.bridgeKey,
          input.convKey,
          input.completedTurns,
          input.currentTurn,
          input.writer,
          input.options,
          input.requestId,
          controller,
          input.streamIdleTimeoutMs,
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
