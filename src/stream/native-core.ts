/**
 * Cursor native provider runtime: translates Pi streamSimple context to Cursor's
 * protobuf/HTTP2 Connect protocol.
 *
 * Based on https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan.
 * Uses Node's http2 via a child process bridge (h2-bridge.mjs).
 */
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent as PiImageContent,
  type Message as PiMessage,
  type Model,
  type SimpleStreamOptions,
  type TextContent as PiTextContent,
  type Tool as PiTool,
  type ToolCall as PiToolCall,
} from "@earendil-works/pi-ai";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  AgentServerMessageSchema,
  CancelActionSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  AgentConversationTurnStructureSchema,
  ConversationTurnStructureSchema,
  AssistantMessageSchema,
  BackgroundShellSpawnResultSchema,
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  DeleteResultSchema,
  DeleteRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientMessageSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  KvClientMessageSchema,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesRejectedSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpArgsSchema,
  McpImageContentSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  McpToolDefinitionSchema,
  McpToolErrorSchema,
  McpToolResultSchema,
  McpToolResultContentItemSchema,
  McpToolsSchema,
  RequestedModelSchema,
  RequestedModel_ModelParameterbytesSchema,
  ReadMcpResourceExecResultSchema,
  ReadMcpResourceRejectedSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RecordScreenFailureSchema,
  RecordScreenResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  ShellStreamSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type ExecServerMessage,
  type InteractionQuery,
  type KvServerMessage,
  type McpToolDefinition,
  type UserMessage,
} from "../proto/agent_pb.js";
import {
  createConnectFrameParser,
  frameConnectMessage,
  parseConnectEndStream,
  spawnBridge,
  type BridgeFactory,
  type BridgeHandle,
} from "../client/bridge.js";
import {
  buildSelectedContextBlob,
  decodeAvailableModelsResponse,
  encodeAvailableModelsRequest,
  type CursorModelParameter,
  type CursorParameterizedModel,
} from "../client/cursor-wire.js";
export type {
  CursorModelParameter,
  CursorParameterizedModel,
  CursorParameterizedVariant,
} from "../client/cursor-wire.js";

import { getCursorAgentUrl as resolveCursorAgentUrl } from "./config.js";
import {
  isContextModeSideChannelText as isContextModeSideChannelTextImpl,
  frameContextModeSideChannel as frameContextModeSideChannelImpl,
  normalizeMessagesForCursor as normalizeMessagesForCursorImpl,
  textContent as textContentImpl,
  contentHasImageParts as contentHasImagePartsImpl,
  type OpenAIMessage as NormalizedOpenAIMessage,
} from "./context-normalize.js";
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
  fingerprintCompletedTurns as fingerprintCompletedTurnsImpl,
  stripInFlightResults as stripInFlightResultsImpl,
  clearStoredMidPauseMetadata as clearStoredMidPauseMetadataImpl,
  type FullHistoryRebuildReason,
  type RecoveryDecision as ExtractedRecoveryDecision,
  type PlanRecoveryInput as ExtractedPlanRecoveryInput,
  type LostToolContinuationDiagnosticInput as ExtractedLostToolContinuationDiagnosticInput,
  type StoredConversation as ExtractedStoredConversation,
  type ParsedTurn as ExtractedParsedTurn,
  type ParsedToolCallStep as ExtractedParsedToolCallStep,
  type ParsedAssistantTextStep as ExtractedParsedAssistantTextStep,
  type ParsedTurnStep as ExtractedParsedTurnStep,
  type ParsedToolResult as ExtractedParsedToolResult,
  type ParsedImageContent as ExtractedParsedImageContent,
  type ToolResultInfo as ExtractedToolResultInfo,
} from "./recovery.js";
import { enhanceCursorStreamError, isAuthErrorMessage } from "./protocol.js";
import { handleInteractionQuery } from "./interaction-query.js";
import {
  setLastIdleTimeout,
  setLastRecoverySkipReason,
  setLastStreamEvent,
} from "../diagnostics/diagnostics.js";

// Cursor CLI's local-image path scales/compresses images to <= 5 MiB
// and accepts only jpeg/png/gif/webp by magic bytes.
const CURSOR_CLI_MAX_IMAGE_BYTES = 5_242_880;
const CURSOR_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_OPENAI_REQUEST_BODY_BYTES = 25 * 1024 * 1024;
// URL resolution lives in ./config.ts
export { getCursorAgentUrl } from "./config.js";
const getCursorAgentUrl = resolveCursorAgentUrl;

// ── Types ──

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ContentPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  image_url?: { url?: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  /** Propagated from Pi toolResult.isError into Cursor MCP results. */
  is_error?: boolean;
}

interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface CursorToolResultImagePayload {
  toolCallId: string;
  images: Array<{ data: string; mimeType: string }>;
}

interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: OpenAIToolDef[];
  tool_choice?: unknown;
  reasoning_effort?: string;
  user?: string;
  pi_session_id?: string;
  cursor_model_id?: string;
  cursor_model_parameters?: CursorModelParameter[];
  cursor_tool_result_images?: CursorToolResultImagePayload[];
  cursor_requires_max_mode?: boolean;
  cursor_model_max_mode?: boolean;
}

interface CursorRequestPayload {
  requestBytes: Uint8Array;
  requestBody: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
}

interface CursorRequestDebugSummary {
  systemPrompt: string;
  selectedImages: Array<{ byteLength: number; mimeType: string }>;
}

interface PendingExec {
  execId: string;
  execMsgId: number;
  toolCallId: string;
  toolName: string;
  decodedArgs: string;
}

interface ActiveBridge {
  bridge: BridgeHandle;
  heartbeatTimer: ReturnType<typeof setInterval>;
  toolTimeoutTimer?: ReturnType<typeof setTimeout>;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  pendingExecs: PendingExec[];
  currentTurn: ParsedTurn;
}

export interface StoredConversation {
  conversationId: string;
  checkpoint: Uint8Array | null;
  checkpointSource?: "upstream" | "absent";
  checkpointTurnCount?: number;
  checkpointHistoryFingerprint?: string;
  midPausePendingToolCalls?: Array<{ toolCallId: string; toolName: string }>;
  midPauseTurnCount?: number;
  midPauseHistoryFingerprint?: string;
  midPauseRecordedAtMs?: number;
  sessionScoped: boolean;
  sessionId?: string;
  blobStore: Map<string, Uint8Array>;
  lastAccessMs: number;
}

interface StreamState {
  toolCallIndex: number;
  pendingExecs: PendingExec[];
  outputTokens: number;
  totalTokens: number;
}

interface IdleRestartContext {
  /** True when text/thinking was already pushed to the Pi writer. */
  emittedUserVisibleContent: boolean;
  latestCheckpoint: Uint8Array | null;
  blobStore: Map<string, Uint8Array>;
  completedTurns: ParsedTurn[];
  currentTurn: ParsedTurn;
}

interface StreamIdleRetryController {
  currentAttempt: number;
  maxRetries: number;
  recoverBeforeRetry?: boolean;
  restart(nextAttempt: number, context: IdleRestartContext): boolean;
}

interface NativeStreamAttemptInput {
  accessToken: string;
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  model: Model<Api>;
  modelId: string;
  bridgeKey: string;
  convKey: string;
  completedTurns: ParsedTurn[];
  currentTurn: ParsedTurn;
  writer: NativeStreamWriter;
  options?: CursorNativeStreamOptions;
  requestId?: string;
  maxIdleRetries?: number;
  streamIdleTimeoutMs?: number;
  getAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string>;
  /** When true, idle timeout tries recovery/rebuild before a blind restart. */
  recoverBeforeRetry?: boolean;
}

interface ToolResultInfo {
  toolCallId: string;
  content: string;
  images?: ParsedImageContent[];
  isError?: boolean;
}

export interface ParsedToolResult {
  content: string;
  isError: boolean;
  images?: ParsedImageContent[];
}

export interface ParsedImageContent {
  data: Uint8Array;
  mimeType: string;
}

export interface ParsedAssistantTextStep {
  kind: "assistantText";
  text: string;
}

export interface ParsedToolCallStep {
  kind: "toolCall";
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: ParsedToolResult;
}

export type ParsedTurnStep = ParsedAssistantTextStep | ParsedToolCallStep;

export interface ParsedTurn {
  userText: string;
  steps: ParsedTurnStep[];
  userImages?: ParsedImageContent[];
}

interface ParsedMessages {
  systemPrompt: string;
  userText: string;
  userImages: ParsedImageContent[];
  turns: ParsedTurn[];
  toolResults: ToolResultInfo[];
  inFlightTurn?: ParsedTurn;
}

// ── State ──

const activeBridges = new Map<string, ActiveBridge>();
const conversationStates = new Map<string, StoredConversation>();
const sessionLocks = new Map<string, Promise<void>>();
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_ACTIVE_BRIDGE_TTL_MS = 60 * 60 * 1000;
// Idle watchdogs and silent retries are off by default so long agent turns can
// run as long as Cursor keeps the stream open. Set the env vars below to re-enable.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 0;
const DEFAULT_RESUME_IDLE_TIMEOUT_MS = 0;
const DEFAULT_STREAM_IDLE_MAX_RETRIES = 0;
const DEFAULT_MIDPAUSE_REBUILD_MAX_AGE_MS = 15 * 60 * 1000;
/** Soft cap on retained blob bytes per conversation (images + turn blobs). */
const MAX_CONVERSATION_BLOB_BYTES = 128 * 1024 * 1024;
const DEFAULT_H2_CONNECT_TIMEOUT_MS = 30_000;
/** 0 = no activity kill (parent heartbeats + Cursor keep the stream alive). */
const DEFAULT_H2_IDLE_TIMEOUT_MS = 0;

export function resolveActiveBridgeTtlMs(envValue?: string): number {
  if (envValue === undefined || envValue === "") return DEFAULT_ACTIVE_BRIDGE_TTL_MS;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed)) return DEFAULT_ACTIVE_BRIDGE_TTL_MS;
  return Math.max(1_000, parsed);
}

export function resolveStreamIdleTimeoutMs(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (parsed === 0) return 0;
  return Math.max(1_000, Math.floor(parsed));
}

export function resolveStreamIdleMaxRetries(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_STREAM_IDLE_MAX_RETRIES;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STREAM_IDLE_MAX_RETRIES;
  if (parsed === 0) return 0;
  return Math.min(10, Math.max(1, Math.floor(parsed)));
}

export function resolveResumeIdleTimeoutMs(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_RESUME_IDLE_TIMEOUT_MS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RESUME_IDLE_TIMEOUT_MS;
  if (parsed === 0) return 0;
  return Math.max(1_000, Math.floor(parsed));
}

export function resolveH2ConnectTimeoutMs(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_H2_CONNECT_TIMEOUT_MS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_H2_CONNECT_TIMEOUT_MS;
  if (parsed === 0) return 0;
  return Math.max(1_000, Math.floor(parsed));
}

export function resolveH2IdleTimeoutMs(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_H2_IDLE_TIMEOUT_MS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_H2_IDLE_TIMEOUT_MS;
  if (parsed === 0) return 0;
  return Math.max(5_000, Math.floor(parsed));
}

/**
 * Whether an interaction-update case should reset the stream idle watchdog.
 * tokenDelta is treated as upstream liveness (long reasoning turns emit it
 * without text for minutes at a time).
 */
export function interactionUpdateCountsAsProgress(
  updateCase: string | undefined,
  hasNonEmptyText = false,
): boolean {
  if (updateCase === "textDelta" || updateCase === "thinkingDelta") return hasNonEmptyText;
  if (updateCase === "tokenDelta") return true;
  if (updateCase === "toolCallCompleted") return true;
  if (updateCase === "toolCallStarted") return true;
  if (updateCase === "partialToolCall") return true;
  if (updateCase === "toolCallDelta") return true;
  if (updateCase === "thinkingCompleted") return true;
  if (updateCase === "heartbeat") return true;
  if (updateCase === "summary" || updateCase === "summaryStarted" || updateCase === "summaryCompleted")
    return true;
  return false;
}

/** Whether a blind full-request restart is safe given already-streamed content. */
export function canBlindIdleRestart(emittedUserVisibleContent: boolean): boolean {
  return !emittedUserVisibleContent;
}

function resolveMidPauseRebuildMaxAgeMs(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_MIDPAUSE_REBUILD_MAX_AGE_MS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MIDPAUSE_REBUILD_MAX_AGE_MS;
  // Zero should keep the replay trust window bounded; negative values are treated as invalid.
  return Math.max(1_000, Math.floor(parsed));
}

function createStreamIdleWatchdog(options: { timeoutMs: number; onTimeout: () => void }): {
  start(): void;
  reset(): void;
  pause(): void;
  resume(): void;
  clear(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let paused = false;
  let fired = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const arm = () => {
    clear();
    if (options.timeoutMs <= 0 || paused || fired) return;
    timer = setTimeout(() => {
      timer = undefined;
      fired = true;
      options.onTimeout();
    }, options.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    start() {
      if (started) return;
      started = true;
      paused = false;
      arm();
    },
    reset() {
      if (paused || fired) return;
      arm();
    },
    pause() {
      paused = true;
      clear();
    },
    resume() {
      if (fired) return;
      paused = false;
      arm();
    },
    clear,
  };
}

const ACTIVE_BRIDGE_TTL_MS = resolveActiveBridgeTtlMs(process.env.PI_CURSOR_ACTIVE_BRIDGE_TTL_MS);
const defaultBridgeFactory: BridgeFactory = (options) => spawnBridge(options, debugLog);
let bridgeFactory: BridgeFactory = defaultBridgeFactory;
let debugRequestCounter = 0;
let debugLogFilePath: string | undefined;
const requestDebugByBody = new WeakMap<Uint8Array, CursorRequestDebugSummary>();

function isProxyDebugEnabled(): boolean {
  const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}

function truncateDebugString(value: string, max = 4000): string {
  return value.length > max
    ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>`
    : value;
}

function debugByteSummary(bytes: Uint8Array): { byteLength: number; sha256: string } {
  return {
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  };
}

function debugBase64ImageSummary(data: string): {
  base64Length: number;
  byteLength?: number;
  sha256?: string;
  decodeError?: boolean;
} {
  const stripped = data.replace(/\s/g, "");
  const bytes = Buffer.from(stripped, "base64");
  if (bytes.length > 0) {
    return { base64Length: data.length, ...debugByteSummary(new Uint8Array(bytes)) };
  }
  if (stripped.length > 0) {
    return { base64Length: data.length, decodeError: true };
  }
  return { base64Length: data.length };
}

function summarizeDebugImageUrl(url: string): unknown {
  const trimmed = url.trim();
  const match = trimmed.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is);
  if (match) {
    return {
      mimeType: normalizeImageMimeType(match[1]!),
      ...debugBase64ImageSummary(match[2]!),
    };
  }
  return {
    url: trimmed.startsWith("data:image/")
      ? `<redacted data image ${trimmed.length} chars>`
      : truncateDebugString(trimmed),
  };
}

function summarizeDebugImageObject(value: Record<string, unknown>): unknown | undefined {
  const imageUrl = value.image_url;
  if (imageUrl && typeof imageUrl === "object") {
    const url = (imageUrl as Record<string, unknown>).url;
    if (typeof url === "string")
      return { type: value.type ?? "image_url", image_url: summarizeDebugImageUrl(url) };
  }

  const mimeType =
    typeof value.mimeType === "string" ? normalizeImageMimeType(value.mimeType) : undefined;
  if (!mimeType?.startsWith("image/")) return undefined;
  const data = value.data;
  if (typeof data === "string") {
    return { type: value.type, mimeType, ...debugBase64ImageSummary(data) };
  }
  if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return { type: value.type, mimeType, ...debugByteSummary(bytes) };
  }
  return undefined;
}

function sanitizeForDebug(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return truncateDebugString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return {
      __type: value instanceof Uint8Array ? "Uint8Array" : "Buffer",
      ...debugByteSummary(bytes),
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForDebug(item));
  if (value instanceof Map) {
    return {
      __type: "Map",
      size: value.size,
      entries: Array.from(value.entries())
        .slice(0, 20)
        .map(([k, v]) => [sanitizeForDebug(k), sanitizeForDebug(v)]),
    };
  }
  if (typeof value === "object") {
    const imageSummary = summarizeDebugImageObject(value as Record<string, unknown>);
    if (imageSummary) return imageSummary;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
      if (key === "accessToken") return [key, "<redacted>"] as const;
      if (key === "data" && typeof inner === "string")
        return [key, `<redacted base64 ${inner.length} chars>`] as const;
      if (key === "url" && typeof inner === "string" && inner.startsWith("data:image/")) {
        return [key, `<redacted data image ${inner.length} chars>`] as const;
      }
      return [key, sanitizeForDebug(inner)] as const;
    });
    return Object.fromEntries(entries);
  }
  return String(value);
}

function getDebugLogFilePath(): string {
  const configured = process.env.PI_CURSOR_PROVIDER_DEBUG_FILE?.trim();
  if (configured) return configured;
  if (debugLogFilePath) return debugLogFilePath;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  debugLogFilePath = pathJoin(tmpdir(), `pi-cursor-provider-debug-${stamp}-${process.pid}.log`);
  return debugLogFilePath;
}

function debugLog(event: string, data?: Record<string, unknown>): void {
  if (!isProxyDebugEnabled()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...(data ? (sanitizeForDebug(data) as Record<string, unknown>) : {}),
  });
  const file = getDebugLogFilePath();
  try {
    appendFileSync(file, `${line}\n`, "utf8");
  } catch (error) {
    console.error("[pi-cursor-provider] failed to write debug log", error);
    console.error(`[pi-cursor-provider] ${line}`);
  }
}

/** Always-on compact lifecycle log for diagnosing multi-minute stalls. */
let lifecycleLogPath: string | undefined;
function getLifecycleLogPath(): string {
  const configured = process.env.PI_CURSOR_LIFECYCLE_LOG?.trim();
  if (configured) return configured;
  if (lifecycleLogPath) return lifecycleLogPath;
  lifecycleLogPath = pathJoin(tmpdir(), "pi-cursor-lifecycle.jsonl");
  return lifecycleLogPath;
}

function lifecycleLog(event: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...(data ? (sanitizeForDebug(data) as Record<string, unknown>) : {}),
  });
  try {
    appendFileSync(getLifecycleLogPath(), `${line}\n`, "utf8");
  } catch {
    // Never throw from diagnostics.
  }
  // Also mirror into verbose debug log when enabled.
  debugLog(`lifecycle.${event}`, data);
}

type MetricEmitter = (event: string, data: Record<string, unknown>) => void;

const defaultMetricEmitter: MetricEmitter = (event, data) => {
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...(sanitizeForDebug(data) as Record<string, unknown>),
    }),
  );
};

let metricEmitter: MetricEmitter = defaultMetricEmitter;

function emitMetric(event: string, data: Record<string, unknown>): void {
  try {
    metricEmitter(event, data);
  } catch (error) {
    console.error("[pi-cursor-provider] failed to emit metric", error);
  }
}

function nextDebugRequestId(): string {
  debugRequestCounter += 1;
  return `req-${debugRequestCounter}`;
}

function decodeRequestForTests(requestBody: Uint8Array): CursorRequestDebugSummary {
  return requestDebugByBody.get(requestBody) ?? { systemPrompt: "", selectedImages: [] };
}

function redactForDebug(value: string): string {
  return value
    .replace(/([A-Z0-9_]*TOKEN[A-Z0-9_]*=)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[redacted]");
}

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
    metricEmitter = factory ?? defaultMetricEmitter;
  },
};

export function setBridgeFactoryForTests(factory?: BridgeFactory): void {
  bridgeFactory = factory ?? defaultBridgeFactory;
}

let proxyServer: ReturnType<typeof createServer> | undefined;
let proxyPort: number | undefined;
let proxyAccessTokenProvider: (() => Promise<string>) | undefined;

// ── Unary RPC (for model discovery) ──

export async function callCursorUnaryRpc(options: {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
}): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  const bridge = bridgeFactory({
    accessToken: options.accessToken,
    rpcPath: options.rpcPath,
    url: options.url,
    unary: true,
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 5_000;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              bridge.proc.kill();
            } catch {
              // Process may already have exited when the unary RPC times out.
            }
          }, timeoutMs)
        : undefined;

    bridge.onData((chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    bridge.onClose((exitCode) => {
      if (timeout) clearTimeout(timeout);
      resolve({ body: Buffer.concat(chunks), exitCode, timedOut });
    });

    bridge.write(options.requestBody);
    bridge.end();
  });
}

// ── Model discovery ──

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  requestedModelId?: string;
  parameters?: CursorModelParameter[];
  requiresMaxMode?: boolean;
  requestedMaxMode?: boolean;
  supportsImages?: boolean;
}

let cachedModels: { tokenHash: string; models: CursorModel[] } | null = null;
let cachedParameterizedModels: { tokenHash: string; models: CursorParameterizedModel[] } | null =
  null;

function tokenCacheHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export async function getCursorModels(apiKey: string): Promise<CursorModel[]> {
  const tokenHash = tokenCacheHash(apiKey);
  if (cachedModels?.tokenHash === tokenHash) return cachedModels.models;
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const requestBody = toBinary(GetUsableModelsRequestSchema, requestPayload);
    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: "/agent.v1.AgentService/GetUsableModels",
      requestBody,
      url: getCursorAgentUrl(),
    });
    if (!response.timedOut && response.exitCode === 0 && response.body.length > 0) {
      let decoded: any = null;
      try {
        decoded = fromBinary(GetUsableModelsResponseSchema, response.body);
      } catch {
        // Try Connect framing after plain protobuf decode fails.
        const body = decodeConnectUnaryBody(response.body);
        if (body) {
          try {
            decoded = fromBinary(GetUsableModelsResponseSchema, body);
          } catch {
            decoded = null;
          }
        }
      }
      if (decoded?.models?.length) {
        const models = normalizeCursorModels(decoded.models);
        if (models.length > 0) {
          cachedModels = { tokenHash, models };
          return models;
        }
      }
    }
  } catch (err) {
    console.error(
      "[cursor-provider] Model discovery failed:",
      err instanceof Error ? err.message : err,
    );
  }
  console.warn("[cursor-provider] Model discovery returned no models");
  return [];
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;
    if ((flags & 0b0000_0001) !== 0) return null;
    if ((flags & 0b0000_0010) === 0) return payload.subarray(offset + 5, frameEnd);
    offset = frameEnd;
  }
  return null;
}

export async function getCursorParameterizedModels(
  apiKey: string,
): Promise<CursorParameterizedModel[]> {
  const tokenHash = tokenCacheHash(apiKey);
  if (cachedParameterizedModels?.tokenHash === tokenHash) return cachedParameterizedModels.models;
  try {
    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: "/aiserver.v1.AiService/AvailableModels",
      requestBody: encodeAvailableModelsRequest(),
    });
    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) return [];
    const body = decodeConnectUnaryBody(response.body) ?? response.body;
    const models = decodeAvailableModelsResponse(body);
    cachedParameterizedModels = { tokenHash, models };
    return models;
  } catch (err) {
    console.error(
      "[cursor-provider] Parameterized model discovery failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

export function inferCursorContextWindow(id: string, name: string): number {
  const text = `${id} ${name}`.toLowerCase();
  if (/\b1\s*m\b|(?:^|-)1m(?:-|$)/.test(text)) return 1_000_000;
  if (/\b272\s*k\b|(?:^|-)272k(?:-|$)/.test(text)) return 272_000;
  return 200_000;
}

function normalizeCursorModels(models: readonly unknown[]): CursorModel[] {
  const byId = new Map<string, CursorModel>();
  for (const model of models) {
    const m = model as any;
    const id = m?.modelId?.trim?.();
    if (!id) continue;
    const name = m.displayName || m.displayNameShort || m.displayModelId || id;
    byId.set(id, {
      id,
      name,
      reasoning: Boolean(m.thinkingDetails),
      contextWindow: inferCursorContextWindow(id, name),
      maxTokens: 64_000,
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ── Proxy server ──

export function getProxyPort(): number | undefined {
  return proxyPort;
}

/** @deprecated Internal OpenAI-compatible proxy path. Prefer native streamSimple. Not part of the public provider surface. */
export async function startProxy(getAccessToken: () => Promise<string>): Promise<number> {
  proxyAccessTokenProvider = getAccessToken;
  if (proxyServer && proxyPort) return proxyPort;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      const requestId = nextDebugRequestId();
      debugLog("http.request", {
        requestId,
        method: req.method,
        pathname: url.pathname,
        headers: req.headers,
      });

      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body) as ChatCompletionRequest;
          debugLog("http.chat.body", { requestId, body: parsed });
          if (!proxyAccessTokenProvider) throw new Error("No access token provider");
          const accessToken = await proxyAccessTokenProvider();
          await withSessionLock(deriveRequestLockKey(parsed), () =>
            handleChatCompletion(parsed, accessToken, req, res, requestId),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const invalidRequest =
            err instanceof SyntaxError || message.startsWith("Request body exceeds ");
          debugLog("http.chat.error", {
            requestId,
            message,
            stack: err instanceof Error ? err.stack : undefined,
          });
          res.writeHead(invalidRequest ? 400 : 500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message,
                type: invalidRequest ? "invalid_request_error" : "server_error",
                code: invalidRequest ? "invalid_request" : "internal_error",
              },
            }),
          );
        }
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        proxyPort = addr.port;
        proxyServer = server;
        debugLog("proxy.start", {
          port: proxyPort,
          debugLogFile: isProxyDebugEnabled() ? getDebugLogFilePath() : undefined,
        });
        resolve(proxyPort);
      } else {
        reject(new Error("Failed to bind proxy"));
      }
    });
  });
}

function clearActiveBridgeToolTimeout(active: ActiveBridge | undefined): void {
  if (active?.toolTimeoutTimer) clearTimeout(active.toolTimeoutTimer);
}

function removeActiveBridge(bridgeKey: string): void {
  clearActiveBridgeToolTimeout(activeBridges.get(bridgeKey));
  activeBridges.delete(bridgeKey);
}

function setActiveBridge(bridgeKey: string, active: Omit<ActiveBridge, "toolTimeoutTimer">): void {
  clearActiveBridgeToolTimeout(activeBridges.get(bridgeKey));
  const toolTimeoutTimer = setTimeout(() => {
    debugLog("bridge.active_ttl_expired", { bridgeKey, ttlMs: ACTIVE_BRIDGE_TTL_MS });
    cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  }, ACTIVE_BRIDGE_TTL_MS);
  toolTimeoutTimer.unref?.();
  activeBridges.set(bridgeKey, { ...active, toolTimeoutTimer });
}

export function cleanupAllSessionState(): void {
  debugLog("session.cleanup_all", {
    activeBridgeCount: activeBridges.size,
    conversationCount: conversationStates.size,
  });
  for (const [bridgeKey, active] of activeBridges) {
    cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  }
  conversationStates.clear();
}

export function stopProxy(): void {
  debugLog("proxy.stop", { port: proxyPort });
  if (proxyServer) {
    proxyServer.close();
    proxyServer = undefined;
    proxyPort = undefined;
    proxyAccessTokenProvider = undefined;
  }
  cleanupAllSessionState();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on("data", (c: Buffer) => {
      if (rejected) return;
      total += c.length;
      if (total > MAX_OPENAI_REQUEST_BODY_BYTES) {
        rejected = true;
        reject(new Error(`Request body exceeds ${MAX_OPENAI_REQUEST_BODY_BYTES} byte limit`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── Native pi streamSimple provider ──

export type CursorNativeModelRouting = ExtractedCursorNativeModelRouting;

export interface CursorNativeStreamConfig {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  getNoReasoningEffortByModelId?(): Map<string, string>;
  getRawModelRoutingByModelId?(): Map<string, Record<string, CursorNativeModelRouting>>;
}

type CursorNativeStreamOptions = SimpleStreamOptions & {
  toolChoice?: unknown;
};

type NativeBlockKind = "text" | "thinking";

interface NativeStreamWriter {
  output: AssistantMessage;
  closed: boolean;
  start(): void;
  text(delta: string): void;
  thinking(delta: string): void;
  toolCall(exec: PendingExec): void;
  done(reason: "stop" | "length" | "toolUse", state?: StreamState): void;
  error(message: string, reason: "error" | "aborted", state?: StreamState): void;
}

function emptyCursorUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function tokenCost(tokens: number, ratePerMillion = 0): number {
  return (tokens * ratePerMillion) / 1_000_000;
}

function applyCursorUsage(output: AssistantMessage, model: Model<Api>, state?: StreamState): void {
  if (!state) return;
  const usage = computeUsage(state);
  const costInput = tokenCost(usage.prompt_tokens, model.cost?.input);
  const costOutput = tokenCost(usage.completion_tokens, model.cost?.output);
  output.usage = {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage.total_tokens,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: 0,
      cacheWrite: 0,
      total: costInput + costOutput,
    },
  };
}

function createCursorAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyCursorUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

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

function isPiTextContent(block: unknown): block is PiTextContent {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
}

function isPiImageContent(block: unknown): block is PiImageContent {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function isPiToolCall(block: unknown): block is PiToolCall {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall";
}

function piContentToOpenAIContent(
  content: string | PiMessage["content"],
): OpenAIMessage["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (isPiTextContent(block)) {
      parts.push({ type: "text", text: block.text });
    } else if (isPiImageContent(block)) {
      parts.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return parts.length > 0 ? parts : "";
}

function assistantTextFromPiContent(content: AssistantMessage["content"]): string {
  return content
    .filter((block): block is PiTextContent => isPiTextContent(block))
    .map((block) => block.text)
    .join("\n");
}

function assistantToolCallsFromPiContent(content: AssistantMessage["content"]): OpenAIToolCall[] {
  return content.filter(isPiToolCall).map((block) => ({
    id: block.id,
    type: "function" as const,
    function: {
      name: block.name,
      arguments: JSON.stringify(block.arguments ?? {}),
    },
  }));
}

function piToolToOpenAI(tool: PiTool): OpenAIToolDef {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  };
}

function resolveNativeReasoningEffort(
  model: Model<Api>,
  options: CursorNativeStreamOptions | undefined,
  noReasoningEffortByModelId?: Map<string, string>,
): string | undefined {
  const thinkingLevelMap =
    (
      model as Model<Api> & {
        thinkingLevelMap?: Partial<Record<string, string>>;
        compat?: { reasoningEffortMap?: Partial<Record<string, string>> };
      }
    ).thinkingLevelMap ??
    (model.compat as { reasoningEffortMap?: Partial<Record<string, string>> } | undefined)
      ?.reasoningEffortMap;
  const requested = options?.reasoning;
  const supportsReasoningEffort =
    (model.compat as { supportsReasoningEffort?: boolean } | undefined)?.supportsReasoningEffort ===
    true;
  if (requested) {
    const mapped = thinkingLevelMap?.[requested];
    if (typeof mapped === "string") return mapped;
    return supportsReasoningEffort ? requested : undefined;
  }
  const offMapped = thinkingLevelMap?.off;
  if (typeof offMapped === "string") return offMapped;
  return noReasoningEffortByModelId?.get(model.id);
}

function applyNativeCursorRouting(
  body: ChatCompletionRequest,
  rawRoutingByModelId?: Map<string, Record<string, CursorNativeModelRouting>>,
): void {
  const routes = rawRoutingByModelId?.get(body.model);
  const effort = body.reasoning_effort ?? "";
  const routing = routes?.[effort] ?? routes?.[""];
  if (!routing) return;
  body.cursor_model_id = routing.modelId;
  if (routing.parameters?.length) body.cursor_model_parameters = routing.parameters;
  if (routing.requiresMaxMode) body.cursor_requires_max_mode = true;
  if (typeof routing.requestedMaxMode === "boolean")
    body.cursor_model_max_mode = routing.requestedMaxMode;
}

function contextToCursorChatCompletionRequest(
  model: Model<Api>,
  context: Context,
  options: CursorNativeStreamOptions | undefined,
  config: CursorNativeStreamConfig,
): ChatCompletionRequest {
  const messages: OpenAIMessage[] = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });

  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: piContentToOpenAIContent(message.content) });
      continue;
    }

    if (message.role === "assistant") {
      const tool_calls = assistantToolCallsFromPiContent(message.content);
      messages.push({
        role: "assistant",
        content: assistantTextFromPiContent(message.content),
        ...(tool_calls.length > 0 ? { tool_calls } : {}),
      });
      continue;
    }

    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: piContentToOpenAIContent(message.content),
        is_error: Boolean((message as { isError?: boolean }).isError),
      });
    }
  }

  const body: ChatCompletionRequest = {
    model: model.id,
    messages,
    stream: true,
    tools: (context.tools ?? []).map(piToolToOpenAI),
    tool_choice: options?.toolChoice,
    reasoning_effort: resolveNativeReasoningEffort(
      model,
      options,
      config.getNoReasoningEffortByModelId?.(),
    ),
    pi_session_id: options?.sessionId,
    user: options?.sessionId,
    temperature: options?.temperature,
    max_tokens: options?.maxTokens,
  };

  applyNativeCursorRouting(body, config.getRawModelRoutingByModelId?.());
  return body;
}

function nativeRequestParameterError(body: ChatCompletionRequest): string | undefined {
  if (body.temperature !== undefined)
    return "Unsupported Cursor provider parameter(s): temperature";
  return undefined;
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

export function evictStaleConversations(now = Date.now()): void {
  for (const [key, stored] of conversationStates) {
    if (!stored.sessionScoped && now - stored.lastAccessMs > CONVERSATION_TTL_MS) {
      debugLog("conversation.evict", { key, stored, now });
      conversationStates.delete(key);
    }
  }
}

function stableNormalizeForHash(value: unknown): unknown {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return { __bytes: debugByteSummary(bytes) };
  }
  if (Array.isArray(value)) return value.map((item) => stableNormalizeForHash(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, inner]) => inner !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, stableNormalizeForHash(inner)]),
    );
  }
  return String(value);
}

function fingerprintImage(image: ParsedImageContent): Record<string, unknown> {
  return {
    mimeType: image.mimeType,
    ...debugByteSummary(image.data),
  };
}

export function fingerprintCompletedTurns(turns: ParsedTurn[]): string {
  return fingerprintCompletedTurnsImpl(turns);
}

function clearStoredMidPauseMetadata(stored: StoredConversation): void {
  clearStoredMidPauseMetadataImpl(stored);
}

function clearStoredCheckpoint(stored: StoredConversation, clearBlobStore = false): void {
  stored.checkpoint = null;
  delete stored.checkpointSource;
  delete stored.checkpointTurnCount;
  delete stored.checkpointHistoryFingerprint;
  clearStoredMidPauseMetadata(stored);
  if (clearBlobStore) stored.blobStore.clear();
}

function discardStaleCheckpointIfNeeded(
  stored: StoredConversation,
  turns: ParsedTurn[],
  requestId: string,
  convKey: string,
): void {
  // Tier 2 extends staleness validation to metadata-only mid-pause snapshots.
  if (!stored.checkpoint) return;

  const currentTurnCount = turns.length;
  const currentHistoryFingerprint = fingerprintCompletedTurns(turns);
  const storedCheckpointTurnCount = stored.checkpointTurnCount;
  const storedCheckpointHistoryFingerprint = stored.checkpointHistoryFingerprint;
  const reason =
    storedCheckpointTurnCount === undefined || !storedCheckpointHistoryFingerprint
      ? "missing_checkpoint_metadata"
      : storedCheckpointTurnCount !== currentTurnCount
        ? "completed_turn_count_mismatch"
        : storedCheckpointHistoryFingerprint !== currentHistoryFingerprint
          ? "completed_history_fingerprint_mismatch"
          : undefined;

  if (!reason) return;

  debugLog("chat.discard_checkpoint", {
    requestId,
    convKey,
    reason,
    storedCheckpointTurnCount,
    currentTurnCount,
    storedCheckpointHistoryFingerprint,
    currentHistoryFingerprint,
  });
  clearStoredCheckpoint(stored, true);
}

function trimBlobStore(
  store: Map<string, Uint8Array>,
  maxBytes = MAX_CONVERSATION_BLOB_BYTES,
): { removed: number; totalBytes: number } {
  let totalBytes = 0;
  for (const value of store.values()) totalBytes += value.byteLength;
  if (totalBytes <= maxBytes) return { removed: 0, totalBytes };

  let removed = 0;
  // Map iteration order is insertion order — drop oldest blobs first.
  for (const key of store.keys()) {
    if (totalBytes <= maxBytes) break;
    const value = store.get(key);
    if (!value) continue;
    totalBytes -= value.byteLength;
    store.delete(key);
    removed += 1;
  }
  return { removed, totalBytes };
}

function mergeBlobStore(stored: StoredConversation, blobStore: Map<string, Uint8Array>): void {
  for (const [k, v] of blobStore) stored.blobStore.set(k, v);
  const trimmed = trimBlobStore(stored.blobStore);
  if (trimmed.removed > 0) {
    debugLog("conversation.blob_store_trimmed", {
      removed: trimmed.removed,
      totalBytes: trimmed.totalBytes,
      maxBytes: MAX_CONVERSATION_BLOB_BYTES,
    });
  }
  stored.lastAccessMs = Date.now();
}

function commitStoredCheckpoint(
  stored: StoredConversation,
  checkpointBytes: Uint8Array,
  blobStore: Map<string, Uint8Array>,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
): void {
  const completedHistory = [...completedTurns, currentTurn];
  mergeBlobStore(stored, blobStore);
  stored.checkpoint = checkpointBytes;
  stored.checkpointSource = "upstream";
  stored.checkpointTurnCount = completedHistory.length;
  stored.checkpointHistoryFingerprint = fingerprintCompletedTurns(completedHistory);
  clearStoredMidPauseMetadata(stored);
}

function persistAbortedConversationState(
  convKey: string,
  latestCheckpoint: Uint8Array | null,
  blobStore: Map<string, Uint8Array>,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
): void {
  const stored = conversationStates.get(convKey);
  if (!stored) return;

  // Pi records the partial assistant response on an aborted stream. Keep Cursor's
  // matching checkpoint as well, so the next turn can continue the same native
  // conversation instead of rebuilding from a potentially truncated transcript.
  if (latestCheckpoint) {
    commitStoredCheckpoint(stored, latestCheckpoint, blobStore, completedTurns, currentTurn);
  } else {
    // Blob ids referenced by the retained Pi history must outlive the cancelled
    // bridge even when Cursor has not emitted a checkpoint yet.
    mergeBlobStore(stored, blobStore);
  }

  debugLog("native.stream.abort_state_saved", {
    convKey,
    hasCheckpoint: !!latestCheckpoint,
    completedTurnCount: completedTurns.length,
    currentTurn,
  });
}

export function commitStoredCheckpointMidPause(
  stored: StoredConversation,
  checkpointBytes: Uint8Array | null,
  blobStore: Map<string, Uint8Array>,
  completedTurns: ParsedTurn[],
  pendingToolCalls: Array<{ toolCallId: string; toolName: string }>,
): void {
  mergeBlobStore(stored, blobStore);
  const completedHistoryFingerprint = fingerprintCompletedTurns(completedTurns);
  if (checkpointBytes) {
    stored.checkpoint = checkpointBytes;
    stored.checkpointSource = "upstream";
    stored.checkpointTurnCount = completedTurns.length;
    stored.checkpointHistoryFingerprint = completedHistoryFingerprint;
  } else {
    // Metadata-only snapshots intentionally discard any older upstream checkpoint so later
    // recovery code cannot accidentally treat stale bytes as authoritative for this pause.
    stored.checkpoint = null;
    stored.checkpointSource = "absent";
    delete stored.checkpointTurnCount;
    delete stored.checkpointHistoryFingerprint;
  }
  stored.midPausePendingToolCalls = pendingToolCalls.map((c) => ({
    toolCallId: c.toolCallId,
    toolName: c.toolName,
  }));
  stored.midPauseTurnCount = completedTurns.length;
  stored.midPauseHistoryFingerprint = completedHistoryFingerprint;
  stored.midPauseRecordedAtMs = Date.now();
}

export interface HandleBridgeCloseMidPauseInput {
  stored: StoredConversation | undefined;
  latestCheckpoint: Uint8Array | null;
  blobStore: Map<string, Uint8Array>;
  completedTurns: ParsedTurn[];
  pendingExecs: Array<{ toolCallId: string; toolName: string }>;
}

export function handleBridgeCloseMidPause(input: HandleBridgeCloseMidPauseInput): {
  committed: boolean;
} {
  if (!input.stored) return { committed: false };
  commitStoredCheckpointMidPause(
    input.stored,
    input.latestCheckpoint,
    input.blobStore,
    input.completedTurns,
    input.pendingExecs,
  );
  return { committed: true };
}

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

function deriveRequestLockKey(body: ChatCompletionRequest): string {
  const sessionId = derivePiSessionId(body);
  if (sessionId) return `session:${sessionId}`;
  return `anonymous:${deriveConversationKey(body.messages)}`;
}

async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => current);
  sessionLocks.set(key, chained);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(key) === chained) sessionLocks.delete(key);
  }
}

function writeJsonError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  type: string,
  code?: string,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } }));
}

function rejectUnsupportedRequestParameters(
  body: ChatCompletionRequest,
  res: ServerResponse,
  requestId: string,
): boolean {
  const raw = body as unknown as Record<string, unknown>;
  // Pi's OpenAI-compatible provider sends max_tokens for normal Cursor requests.
  // Cursor's agent protocol controls output budgeting server-side here, so accept
  // max_tokens/max_completion_tokens as no-op compatibility fields rather than
  // breaking every request. Sampling controls remain rejected so users are not
  // misled into thinking they are honored.
  const unsupported = [["temperature", raw.temperature]].filter(([, value]) => value !== undefined);
  if (unsupported.length === 0) return false;

  debugLog("chat.unsupported_parameters", {
    requestId,
    parameters: unsupported.map(([name]) => name),
  });
  writeJsonError(
    res,
    400,
    `Unsupported Cursor proxy parameter(s): ${unsupported.map(([name]) => name).join(", ")}`,
    "invalid_request_error",
    "unsupported_parameter",
  );
  return true;
}

function resolveToolsForToolChoice(
  tools: OpenAIToolDef[],
  toolChoice: unknown,
): { tools: OpenAIToolDef[] } | { error: string } {
  if (toolChoice == null || toolChoice === "auto") return { tools };
  if (toolChoice === "none") return { tools: [] };
  if (
    typeof toolChoice === "object" &&
    toolChoice &&
    (toolChoice as Record<string, unknown>).type === "none"
  )
    return { tools: [] };
  return { error: "Only tool_choice 'auto' and 'none' are supported by pi-cursor-provider." };
}

async function handleChatCompletion(
  body: ChatCompletionRequest,
  accessToken: string,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  let parsedMessages: ParsedMessages;
  try {
    parsedMessages = parseMessages(body.messages, body.cursor_tool_result_images);
  } catch (error) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }
  const { systemPrompt, userText, userImages, turns, toolResults, inFlightTurn } = parsedMessages;
  const modelId = resolveRequestedModelId(body.model, body.reasoning_effort, body.cursor_model_id);
  if (body.reasoning_effort && !body.cursor_model_id && !body.cursor_model_parameters) {
    debugLog("model_routing.fallback_suffix_generation", {
      requestId,
      model: body.model,
      reasoning_effort: body.reasoning_effort,
      resolvedModelId: modelId,
    });
  }
  const maxMode =
    typeof body.cursor_model_max_mode === "boolean"
      ? body.cursor_model_max_mode
      : body.cursor_requires_max_mode === true;
  if (rejectUnsupportedRequestParameters(body, res, requestId)) return;
  const toolResolution = resolveToolsForToolChoice(body.tools ?? [], body.tool_choice);
  if ("error" in toolResolution) {
    debugLog("chat.unsupported_tool_choice", { requestId, tool_choice: body.tool_choice });
    writeJsonError(
      res,
      400,
      toolResolution.error,
      "invalid_request_error",
      "unsupported_tool_choice",
    );
    return;
  }
  const tools = toolResolution.tools;

  debugLog("chat.parsed_messages", {
    requestId,
    systemPrompt,
    userText,
    turns,
    toolResults,
    messageCount: body.messages.length,
    model: body.model,
    cursorModelId: body.cursor_model_id,
    cursorModelParameters: body.cursor_model_parameters,
    cursorRequiresMaxMode: body.cursor_requires_max_mode,
    cursorModelMaxMode: body.cursor_model_max_mode,
    resolvedModelId: modelId,
    stream: body.stream !== false,
    maxMode,
  });

  if (!userText && userImages.length === 0 && toolResults.length === 0) {
    debugLog("chat.no_user_message", { requestId, messages: body.messages });
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "No user message found", type: "invalid_request_error" },
      }),
    );
    return;
  }

  if (body.stream === false && tools.length > 0) {
    debugLog("chat.nonstream_tools_unsupported", { requestId, toolCount: tools.length });
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            "stream:false with tools is not supported by pi-cursor-provider; use streaming tool calls instead.",
          type: "invalid_request_error",
          code: "nonstream_tools_unsupported",
        },
      }),
    );
    return;
  }

  const sessionId = derivePiSessionId(body);
  const bridgeKey = deriveBridgeKey(body.messages, sessionId);
  const convKey = deriveConversationKey(body.messages, sessionId);
  const activeBridge = activeBridges.get(bridgeKey);
  debugLog("chat.session_keys", {
    requestId,
    sessionId,
    bridgeKey,
    convKey,
    hasActiveBridge: !!activeBridge,
  });

  if (toolResults.length > 0) {
    if (activeBridge) {
      debugLog("chat.resume_tool_results", {
        requestId,
        bridgeKey,
        toolResults,
        pendingExecs: activeBridge.pendingExecs,
      });
      removeActiveBridge(bridgeKey);
      if (activeBridge.bridge.alive) {
        handleToolResultResume(
          activeBridge,
          toolResults,
          modelId,
          bridgeKey,
          convKey,
          turns,
          req,
          res,
          body.stream !== false,
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
      const mcpTools = buildMcpToolDefinitions(tools);
      const recoveredCurrentTurn: ParsedTurn = {
        userText: decision.wrappedText,
        steps: [],
      };
      const accessToken = proxyAccessTokenProvider ? await proxyAccessTokenProvider() : "";
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
      if (body.stream === false) {
        await handleNonStreamingResponse(
          payload,
          accessToken,
          modelId,
          convKey,
          turns,
          recoveredCurrentTurn,
          req,
          res,
          requestId,
        );
      } else {
        handleStreamingResponse(
          payload,
          accessToken,
          modelId,
          bridgeKey,
          convKey,
          turns,
          recoveredCurrentTurn,
          req,
          res,
          requestId,
        );
      }
      return;
    }
    if (decision.kind === "rebuild_full_history") {
      logFullHistoryRebuild("chat.rebuild_full_history", {
        requestId,
        bridgeKey,
        convKey,
        modelId,
        decision,
      });
      const mcpTools = buildMcpToolDefinitions(tools);
      const rebuiltCompletedTurns = [...decision.completedTurns, decision.inFlightTurn];
      const recoveredUserImages = collectToolResultImages(decision.toolResults);
      const recoveredCurrentTurn: ParsedTurn = {
        userText: decision.wrappedText,
        steps: [],
        ...(recoveredUserImages.length ? { userImages: recoveredUserImages } : {}),
      };
      const accessToken = proxyAccessTokenProvider ? await proxyAccessTokenProvider() : "";
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
      if (recoveryStored) recoveryStored.lastAccessMs = Date.now();
      if (body.stream === false) {
        await handleNonStreamingResponse(
          payload,
          accessToken,
          modelId,
          convKey,
          rebuiltCompletedTurns,
          recoveredCurrentTurn,
          req,
          res,
          requestId,
        );
      } else {
        handleStreamingResponse(
          payload,
          accessToken,
          modelId,
          bridgeKey,
          convKey,
          rebuiltCompletedTurns,
          recoveredCurrentTurn,
          req,
          res,
          requestId,
        );
      }
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
    debugLog("chat.lost_tool_continuation", {
      requestId,
      bridgeKey,
      bridgeKeyPrefix: bridgeKeyPrefix(bridgeKey),
      convKey,
      skipReason: decision.reason,
      toolResults,
      hadStoredCheckpoint: decision.hadStoredCheckpoint,
    });
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        lostToolContinuationErrorBody({
          bridgeKey,
          hadStoredCheckpoint: decision.hadStoredCheckpoint,
          skipReason: decision.reason,
        }),
      ),
    );
    return;
  }

  if (activeBridge && activeBridges.has(bridgeKey)) {
    clearInterval(activeBridge.heartbeatTimer);
    activeBridge.bridge.end();
    removeActiveBridge(bridgeKey);
  }

  let stored = conversationStates.get(convKey);
  debugLog("chat.stored_state.before", { requestId, convKey, stored });
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

  const mcpTools = buildMcpToolDefinitions(tools);
  const effectiveUserText =
    userText || (toolResults.length > 0 ? toolResults.map((r) => r.content).join("\n") : "");
  const effectiveUserImages = userText || userImages.length > 0 ? userImages : [];
  if (!stored.checkpoint) {
    debugLog("chat.no_checkpoint", { requestId, convKey, conversationId: stored.conversationId });
  }
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
  debugLog("chat.cursor_request", {
    requestId,
    conversationId: stored.conversationId,
    effectiveUserText,
    turnCount: turns.length,
    hasCheckpoint: !!stored.checkpoint,
    payload,
  });
  payload.mcpTools = mcpTools;

  const currentTurn: ParsedTurn = {
    userText: effectiveUserText,
    steps: [],
    ...(effectiveUserImages.length > 0 ? { userImages: effectiveUserImages } : {}),
  };

  if (body.stream === false) {
    debugLog("chat.dispatch_nonstream", { requestId, convKey });
    await handleNonStreamingResponse(
      payload,
      accessToken,
      modelId,
      convKey,
      turns,
      currentTurn,
      req,
      res,
      requestId,
    );
  } else {
    debugLog("chat.dispatch_stream", { requestId, bridgeKey, convKey });
    handleStreamingResponse(
      payload,
      accessToken,
      modelId,
      bridgeKey,
      convKey,
      turns,
      currentTurn,
      req,
      res,
      requestId,
    );
  }
}

// ── Message parsing ──

function textContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

interface ImageDecodeOptions {
  enforceCursorCliLimits?: boolean;
}

function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function sniffCursorImageMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return undefined;
}

function validateCursorCliImageLimits(bytes: Uint8Array): string {
  if (bytes.length > CURSOR_CLI_MAX_IMAGE_BYTES) {
    throw new Error(
      `Image exceeds Cursor CLI's ${CURSOR_CLI_MAX_IMAGE_BYTES} byte limit after processing.`,
    );
  }
  const sniffedMimeType = sniffCursorImageMimeType(bytes);
  if (!sniffedMimeType || !CURSOR_SUPPORTED_IMAGE_MIME_TYPES.has(sniffedMimeType)) {
    throw new Error("Unsupported image type: supported formats are jpeg, png, gif, or webp.");
  }
  return sniffedMimeType;
}

function decodeBase64Image(
  data: string,
  mimeType: string,
  options: ImageDecodeOptions = {},
): ParsedImageContent | undefined {
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  if (!normalizedMimeType.startsWith("image/")) return undefined;
  const base64 = data.replace(/\s/g, "");
  if (!base64) return undefined;
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length === 0) return undefined;
  const finalMimeType = options.enforceCursorCliLimits
    ? validateCursorCliImageLimits(bytes)
    : normalizedMimeType;
  return { data: bytes, mimeType: finalMimeType };
}

function parseImageDataUrl(
  url: string,
  options: ImageDecodeOptions = {},
): ParsedImageContent | undefined {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      "Remote image URLs are not supported by pi-cursor-provider. Attach the image or send an inline data:image/...;base64,... URL.",
    );
  }
  if (!trimmed.startsWith("data:")) {
    throw new Error(
      "Only inline data:image/...;base64,... image_url values are supported by pi-cursor-provider.",
    );
  }
  const match = trimmed.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is);
  if (!match) {
    throw new Error("Unsupported image_url format. Expected data:image/...;base64,...");
  }
  const image = decodeBase64Image(match[2]!, match[1]!, options);
  if (!image) {
    throw new Error("Unsupported image_url MIME type. Expected data:image/...;base64,...");
  }
  return image;
}

function contentHasImageParts(content: OpenAIMessage["content"]): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        (part.type === "image_url" && !!part.image_url?.url) ||
        (part.type === "image" && !!part.data && !!part.mimeType),
    )
  );
}

function imageContent(
  content: OpenAIMessage["content"],
  options: ImageDecodeOptions = {},
): ParsedImageContent[] {
  if (content == null || typeof content === "string") return [];
  const images: ParsedImageContent[] = [];
  for (const part of content) {
    if (part.type === "image_url" && part.image_url?.url) {
      const image = parseImageDataUrl(part.image_url.url, options);
      if (image) images.push(image);
    } else if (part.type === "image" && part.data && part.mimeType) {
      const image = decodeBase64Image(part.data, part.mimeType, options);
      if (image) images.push(image);
    }
  }
  return images;
}

function imageKey(image: ParsedImageContent): string {
  return `${image.mimeType}:${createHash("sha256").update(image.data).digest("hex")}`;
}

function mergeImages(
  ...groups: Array<ParsedImageContent[] | undefined>
): ParsedImageContent[] | undefined {
  const merged: ParsedImageContent[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const image of group ?? []) {
      const key = imageKey(image);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(image);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function parseToolResultImagePayloads(
  payloads: CursorToolResultImagePayload[] | undefined,
): Map<string, ParsedImageContent[]> {
  const byToolCallId = new Map<string, ParsedImageContent[]>();
  for (const payload of payloads ?? []) {
    if (!payload?.toolCallId || !Array.isArray(payload.images)) continue;
    const images = payload.images
      .map((image) =>
        decodeBase64Image(image.data, image.mimeType, { enforceCursorCliLimits: true }),
      )
      .filter((image): image is ParsedImageContent => !!image);
    if (images.length === 0) continue;
    byToolCallId.set(
      payload.toolCallId,
      mergeImages(byToolCallId.get(payload.toolCallId), images) ?? [],
    );
  }
  return byToolCallId;
}

function isSyntheticToolResultImageMessage(msg: OpenAIMessage): boolean {
  return (
    msg.role === "user" &&
    textContent(msg.content).trim() === "Attached image(s) from tool result:" &&
    contentHasImageParts(msg.content)
  );
}

type ToolCallStepWithResult = ParsedToolCallStep & { result: ParsedToolResult };

function isToolCallStepWithResult(step: ParsedTurnStep): step is ToolCallStepWithResult {
  return step.kind === "toolCall" && step.result !== undefined;
}

function attachSyntheticToolResultImages(turn: ParsedTurn, images: ParsedImageContent[]): void {
  if (images.length === 0) return;
  const resultSteps = turn.steps
    .filter(isToolCallStepWithResult)
    .filter((step) => !step.result.images?.length);
  if (resultSteps.length === 0) return;

  const imageOnlySteps = resultSteps.filter(
    (step) => step.result.content.trim() === "(see attached image)",
  );
  if (imageOnlySteps.length === images.length) {
    imageOnlySteps.forEach((step, index) => {
      step.result = { ...step.result, content: "", images: [images[index]!] };
    });
    return;
  }

  const target = imageOnlySteps.length === 1 ? imageOnlySteps[0]! : resultSteps.at(-1)!;
  target.result = {
    ...target.result,
    content: target.result.content.trim() === "(see attached image)" ? "" : target.result.content,
    images: mergeImages(target.result.images, images),
  };
}

function normalizeToolResultText(
  content: string,
  images: ParsedImageContent[] | undefined,
): string {
  return images?.length && content.trim() === "(see attached image)" ? "" : content;
}

function parseToolCallArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return raw ? { __raw: raw } : {};
  }
}

function isToolCallStep(step: ParsedTurnStep): step is ParsedToolCallStep {
  return step.kind === "toolCall";
}

function getTurnToolCallResults(turn: ParsedTurn): Map<string, ParsedToolResult> {
  const results = new Map<string, ParsedToolResult>();
  for (const step of turn.steps) {
    if (step.kind === "toolCall" && step.result) results.set(step.toolCallId, step.result);
  }
  return results;
}

function appendAssistantTextToTurn(turn: ParsedTurn, text: string): void {
  if (!text) return;
  const last = turn.steps.at(-1);
  if (last?.kind === "assistantText") {
    last.text += text;
  } else {
    turn.steps.push({ kind: "assistantText", text });
  }
}

function stripTurnRuntimeState(
  turn: ParsedTurn & {
    toolCallById?: Map<string, ParsedToolCallStep>;
    sawToolResult?: boolean;
    sawAssistantAfterToolResult?: boolean;
  },
): ParsedTurn {
  return {
    userText: turn.userText,
    steps: turn.steps,
    ...(turn.userImages?.length ? { userImages: turn.userImages } : {}),
  };
}

function clonePlainValue(value: unknown): unknown {
  // Tool-call arguments are JSON-compatible today; this clone keeps object/array
  // structure isolated without trying to preserve arbitrary class instances.
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return new Uint8Array(bytes);
  }
  if (Array.isArray(value)) return value.map((item) => clonePlainValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        clonePlainValue(inner),
      ]),
    );
  }
  return value;
}

function cloneParsedImage(image: ParsedImageContent): ParsedImageContent {
  return { data: new Uint8Array(image.data), mimeType: image.mimeType };
}

function stripInFlightResults(turn: ParsedTurn): ParsedTurn {
  return stripInFlightResultsImpl(turn);
}

export function isContextModeSideChannelText(text: string): boolean {
  return isContextModeSideChannelTextImpl(text);
}

export function frameContextModeSideChannel(text: string): string {
  return frameContextModeSideChannelImpl(text);
}

export function normalizeMessagesForCursor(messages: OpenAIMessage[]): OpenAIMessage[] {
  return normalizeMessagesForCursorImpl(messages as NormalizedOpenAIMessage[]) as OpenAIMessage[];
}

export function parseMessages(
  messages: OpenAIMessage[],
  toolResultImagePayloads?: CursorToolResultImagePayload[],
): ParsedMessages {
  messages = normalizeMessagesForCursor(messages);
  let systemPrompt = "You are a helpful assistant.";
  const turns: ParsedTurn[] = [];
  const toolResultImagesById = parseToolResultImagePayloads(toolResultImagePayloads);

  debugLog("parse_messages.start", { messages });

  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => textContent(m.content));
  if (systemParts.length > 0) systemPrompt = systemParts.join("\n");

  const nonSystem = messages.filter((m) => m.role !== "system");
  let currentTurn:
    | (ParsedTurn & {
        toolCallById: Map<string, ParsedToolCallStep>;
        sawToolResult: boolean;
        sawAssistantAfterToolResult: boolean;
      })
    | null = null;

  const finalizeCurrentTurn = () => {
    if (!currentTurn) return;
    turns.push(stripTurnRuntimeState(currentTurn));
    currentTurn = null;
  };

  for (const msg of nonSystem) {
    if (currentTurn && isSyntheticToolResultImageMessage(msg)) {
      const hasMetadataImages = currentTurn.steps.some(
        (step) => step.kind === "toolCall" && step.result?.images?.length,
      );
      if (!hasMetadataImages) {
        attachSyntheticToolResultImages(
          currentTurn,
          imageContent(msg.content, { enforceCursorCliLimits: true }),
        );
      }
      continue;
    }

    if (msg.role === "user") {
      finalizeCurrentTurn();
      const userImages = imageContent(msg.content, { enforceCursorCliLimits: true });
      currentTurn = {
        userText: textContent(msg.content),
        steps: [],
        ...(userImages.length > 0 ? { userImages } : {}),
        toolCallById: new Map(),
        sawToolResult: false,
        sawAssistantAfterToolResult: false,
      };
      continue;
    }

    if (!currentTurn) continue;

    if (msg.role === "assistant") {
      const text = textContent(msg.content);
      if (text) {
        if (currentTurn.sawToolResult) currentTurn.sawAssistantAfterToolResult = true;
        currentTurn.steps.push({ kind: "assistantText", text });
      }

      for (const toolCall of msg.tool_calls ?? []) {
        const step: ParsedToolCallStep = {
          kind: "toolCall",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          arguments: parseToolCallArguments(toolCall.function.arguments),
        };
        currentTurn.steps.push(step);
        currentTurn.toolCallById.set(step.toolCallId, step);
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = msg.tool_call_id ?? "";
      const inlineImages = imageContent(msg.content, { enforceCursorCliLimits: true });
      const images = mergeImages(inlineImages, toolResultImagesById.get(toolCallId));
      const content = normalizeToolResultText(textContent(msg.content), images);
      const isError = msg.is_error === true;
      const existing = toolCallId ? currentTurn.toolCallById.get(toolCallId) : undefined;
      if (existing) {
        existing.result = { content, images, isError };
      } else {
        const step: ParsedToolCallStep = {
          kind: "toolCall",
          toolCallId,
          toolName: "",
          arguments: {},
          result: { content, images, isError },
        };
        currentTurn.steps.push(step);
        if (toolCallId) currentTurn.toolCallById.set(toolCallId, step);
      }
      currentTurn.sawToolResult = true;
    }
  }

  let userText = "";
  let userImages: ParsedImageContent[] = [];
  let toolResults: ToolResultInfo[] = [];
  let inFlightTurn: ParsedTurn | undefined;

  if (currentTurn) {
    const toolCallSteps = currentTurn.steps.filter(isToolCallStep);
    const hasAnyToolResults = toolCallSteps.some((step) => step.result);
    const lastStep = currentTurn.steps.at(-1);
    const isToolContinuation = lastStep?.kind === "toolCall";

    if (currentTurn.steps.length === 0 || isToolContinuation) {
      userText = currentTurn.userText;
      userImages = currentTurn.userImages ?? [];
      if (toolCallSteps.length > 0) inFlightTurn = stripInFlightResults(currentTurn);
      if (hasAnyToolResults) {
        toolResults = toolCallSteps.filter(isToolCallStepWithResult).map((step) => ({
          toolCallId: step.toolCallId,
          content: step.result.content,
          ...(step.result.images?.length ? { images: step.result.images } : {}),
          ...(step.result.isError ? { isError: true } : {}),
        }));
      }
    } else {
      turns.push(stripTurnRuntimeState(currentTurn));
    }
  }

  const parsed = { systemPrompt, userText, userImages, turns, toolResults, inFlightTurn };
  debugLog("parse_messages.end", parsed);
  return parsed;
}

// ── Tool definitions ──

function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
  return tools.map((t) => {
    const fn = t.function;
    const jsonSchema: JsonValue =
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as JsonValue)
        : { type: "object", properties: {}, required: [] };
    // Cursor CLI's current schema uses google.protobuf.Value for
    // McpToolDefinition.input_schema. The committed generated schema still
    // exposes that field as bytes, but the outer wire encoding is identical
    // for bytes and message fields (length-delimited field #3), so place the
    // serialized Value bytes here.
    const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema));
    return create(McpToolDefinitionSchema, {
      name: fn.name,
      description: fn.description || "",
      providerIdentifier: "pi",
      toolName: fn.name,
      inputSchema,
    });
  });
}

function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value);
    return toJson(ValueSchema, parsed);
  } catch {
    // Not a protobuf Value; treat bytes as UTF-8 text for MCP tool args.
    return new TextDecoder().decode(value);
  }
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) decoded[key] = decodeMcpArgValue(value);
  return decoded;
}

// ── Build Cursor protobuf request ──

function encodeMcpArgValue(value: unknown): Uint8Array {
  try {
    return toBinary(ValueSchema, fromJson(ValueSchema, value as JsonValue));
  } catch {
    return new TextEncoder().encode(String(value));
  }
}

function encodeMcpArgsMap(args: Record<string, unknown>): Record<string, Uint8Array> {
  const encoded: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(args)) encoded[key] = encodeMcpArgValue(value);
  return encoded;
}

function storeAsBlob(data: Uint8Array, blobStore: Map<string, Uint8Array>): Uint8Array {
  const id = new Uint8Array(createHash("sha256").update(data).digest());
  blobStore.set(Buffer.from(id).toString("hex"), data);
  return id;
}

function createSelectedImages(images: ParsedImageContent[]) {
  // Matches Cursor CLI's ACP image path for inline image data:
  // new SelectedImage({ dataOrBlobId: { case: "data", value }, uuid, mimeType })
  return images.map((image) =>
    create(SelectedImageSchema, {
      uuid: crypto.randomUUID(),
      mimeType: image.mimeType,
      dataOrBlobId: { case: "data", value: image.data },
    }),
  );
}

function createUserMessage(
  text: string,
  selectedContextBlob: Uint8Array,
  images: ParsedImageContent[] = [],
): UserMessage {
  const messageId = crypto.randomUUID();
  return create(UserMessageSchema, {
    text,
    messageId,
    selectedContext: create(SelectedContextSchema, {
      selectedImages: createSelectedImages(images),
    }),
    mode: 1,
    selectedContextBlob,
    correlationId: messageId,
  });
}

function buildMcpSuccessContent(result: ParsedToolResult) {
  const content = [];
  if (result.content.length > 0) {
    content.push(
      create(McpToolResultContentItemSchema, {
        content: {
          case: "text",
          value: create(McpTextContentSchema, { text: result.content }),
        },
      }),
    );
  }
  for (const image of result.images ?? []) {
    content.push(
      create(McpToolResultContentItemSchema, {
        content: {
          case: "image",
          value: create(McpImageContentSchema, { data: image.data, mimeType: image.mimeType }),
        },
      }),
    );
  }
  if (content.length === 0) {
    content.push(
      create(McpToolResultContentItemSchema, {
        content: { case: "text", value: create(McpTextContentSchema, { text: "" }) },
      }),
    );
  }
  return content;
}

function buildTurnStepBytes(step: ParsedTurnStep): Uint8Array {
  if (step.kind === "assistantText") {
    return toBinary(
      ConversationStepSchema,
      create(ConversationStepSchema, {
        message: {
          case: "assistantMessage",
          value: create(AssistantMessageSchema, { text: step.text }),
        },
      }),
    );
  }

  const toolName = step.toolName || "tool";
  const mcpToolCall = create(McpToolCallSchema, {
    args: create(McpArgsSchema, {
      name: toolName,
      args: encodeMcpArgsMap(step.arguments),
      toolCallId: step.toolCallId,
      providerIdentifier: "pi",
      toolName,
    }),
    ...(step.result && {
      result: create(McpToolResultSchema, {
        result: step.result.isError
          ? {
              case: "error",
              value: create(McpToolErrorSchema, { error: step.result.content }),
            }
          : {
              case: "success",
              value: create(McpSuccessSchema, {
                content: buildMcpSuccessContent(step.result),
                isError: false,
              }),
            },
      }),
    }),
  });

  return toBinary(
    ConversationStepSchema,
    create(ConversationStepSchema, {
      message: {
        case: "toolCall",
        value: create(ToolCallSchema, {
          tool: {
            case: "mcpToolCall",
            value: mcpToolCall,
          },
        }),
      },
    }),
  );
}

type BuildCursorRequestImageInput =
  | ParsedImageContent
  | {
      data: string;
      mimeType: string;
    };

interface BuildCursorRequestTurnInput extends Omit<ParsedTurn, "userImages"> {
  images?: BuildCursorRequestImageInput[];
  userImages?: BuildCursorRequestImageInput[];
}

export interface BuildCursorRequestOptions {
  checkpoint: Uint8Array | null;
  conversationId: string;
  cursorModelParameters?: CursorModelParameter[];
  existingBlobStore?: Map<string, Uint8Array>;
  mcpTools?: McpToolDefinition[];
  modelId: string;
  systemPrompt: string;
  turns?: BuildCursorRequestTurnInput[];
  userImages?: BuildCursorRequestImageInput[];
  userText?: string;
  maxMode?: boolean;
}

function normalizeImageInput(image: BuildCursorRequestImageInput): ParsedImageContent {
  if (image.data instanceof Uint8Array) {
    return {
      data: image.data,
      mimeType: image.mimeType,
    };
  }
  return {
    data: new Uint8Array(Buffer.from(image.data.replace(/\s/g, ""), "base64")),
    mimeType: image.mimeType,
  };
}

function normalizeTurnInput(turn: BuildCursorRequestTurnInput): ParsedTurn {
  const images = turn.userImages ?? turn.images;
  return {
    userText: turn.userText,
    steps: turn.steps,
    ...(images && images.length > 0 ? { userImages: images.map(normalizeImageInput) } : {}),
  };
}

export function buildCursorRequest(
  modelOrOptions: string | BuildCursorRequestOptions,
  systemPrompt?: string,
  userText?: string,
  turns?: ParsedTurn[],
  conversationId?: string,
  checkpoint?: Uint8Array | null,
  existingBlobStore?: Map<string, Uint8Array>,
  maxMode = false,
  cursorModelParameters: CursorModelParameter[] = [],
  mcpTools: McpToolDefinition[] = [],
  userImages: ParsedImageContent[] = [],
): CursorRequestPayload {
  if (typeof modelOrOptions !== "string") {
    const normalizedTurns = (modelOrOptions.turns ?? []).map(normalizeTurnInput);
    const currentTurn =
      modelOrOptions.userText === undefined && normalizedTurns.length > 0
        ? normalizedTurns[normalizedTurns.length - 1]
        : undefined;
    const completedTurns = currentTurn ? normalizedTurns.slice(0, -1) : normalizedTurns;
    const currentImages = modelOrOptions.userImages
      ? modelOrOptions.userImages.map(normalizeImageInput)
      : (currentTurn?.userImages ?? []);

    return buildCursorRequestFromParts(
      modelOrOptions.modelId,
      modelOrOptions.systemPrompt,
      modelOrOptions.userText ?? currentTurn?.userText ?? "",
      completedTurns,
      modelOrOptions.conversationId,
      modelOrOptions.checkpoint,
      modelOrOptions.existingBlobStore,
      modelOrOptions.maxMode ?? false,
      modelOrOptions.cursorModelParameters ?? [],
      modelOrOptions.mcpTools ?? [],
      currentImages,
    );
  }

  return buildCursorRequestFromParts(
    modelOrOptions,
    systemPrompt ?? "",
    userText ?? "",
    turns ?? [],
    conversationId ?? crypto.randomUUID(),
    checkpoint ?? null,
    existingBlobStore,
    maxMode,
    cursorModelParameters,
    mcpTools,
    userImages,
  );
}

function buildCursorRequestFromParts(
  modelId: string,
  systemPrompt: string,
  userText: string,
  turns: ParsedTurn[],
  conversationId: string,
  checkpoint: Uint8Array | null,
  existingBlobStore?: Map<string, Uint8Array>,
  maxMode = false,
  cursorModelParameters: CursorModelParameter[] = [],
  mcpTools: McpToolDefinition[] = [],
  userImages: ParsedImageContent[] = [],
): CursorRequestPayload {
  debugLog("cursor_request.build.start", {
    modelId,
    systemPrompt,
    userText,
    turns,
    conversationId,
    checkpoint,
    existingBlobStore,
    maxMode,
    cursorModelParameters,
    mcpToolCount: mcpTools.length,
    userImageCount: userImages.length,
  });
  const blobStore = new Map<string, Uint8Array>(existingBlobStore ?? []);

  const systemBytes = new TextEncoder().encode(
    JSON.stringify({ role: "system", content: systemPrompt }),
  );
  const systemBlobId = storeAsBlob(systemBytes, blobStore);
  const selectedCtxBlob = storeAsBlob(buildSelectedContextBlob([systemBlobId], "pi"), blobStore);

  let conversationState;
  if (checkpoint) {
    conversationState = fromBinary(ConversationStateStructureSchema, checkpoint);
  } else {
    const turnBlobIds: Uint8Array[] = [];
    for (const turn of turns) {
      const userMsg = createUserMessage(turn.userText, selectedCtxBlob, turn.userImages ?? []);
      const userMsgBlobId = storeAsBlob(toBinary(UserMessageSchema, userMsg), blobStore);
      const stepBlobIds = turn.steps.map((s) => storeAsBlob(buildTurnStepBytes(s), blobStore));

      const agentTurn = create(AgentConversationTurnStructureSchema, {
        userMessage: userMsgBlobId,
        steps: stepBlobIds,
        requestId: crypto.randomUUID(),
      });
      const turnStructure = create(ConversationTurnStructureSchema, {
        turn: { case: "agentConversationTurn", value: agentTurn },
      });
      turnBlobIds.push(
        storeAsBlob(toBinary(ConversationTurnStructureSchema, turnStructure), blobStore),
      );
    }

    conversationState = create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: [systemBlobId],
      turns: turnBlobIds,
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: [pathToFileURL(process.cwd()).href],
      mode: 1,
      fileStates: {},
      fileStatesV2: {},
      summaryArchives: [],
      turnTimings: [],
      subagentStates: {},
      selfSummaryCount: 0,
      readPaths: [],
      clientName: "pi",
    });
  }

  const userMessage = createUserMessage(userText, selectedCtxBlob, userImages);
  const action = create(ConversationActionSchema, {
    action: { case: "userMessageAction", value: create(UserMessageActionSchema, { userMessage }) },
  });
  // Cursor's newer request path uses requestedModel instead of legacy modelDetails.
  // Some Cursor models (for example GPT-5.5) use requestedModel.parameters
  // for context/reasoning/fast instead of encoding everything in the model ID.
  // Max Mode is routed from model metadata for parameterized variants.
  debugLog("cursor_request.requested_model", {
    modelId,
    maxMode,
    parameters: cursorModelParameters,
  });
  const parameters = cursorModelParameters.map((parameter) =>
    create(RequestedModel_ModelParameterbytesSchema, parameter),
  );
  const requestedModel = create(RequestedModelSchema, { modelId, maxMode, parameters });
  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    requestedModel,
    conversationId,
    mcpTools: create(McpToolsSchema, { mcpTools }),
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });

  const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);
  const payload = {
    requestBytes,
    requestBody: requestBytes,
    blobStore,
    mcpTools,
  };
  requestDebugByBody.set(requestBytes, {
    systemPrompt,
    selectedImages: userImages.map((image) => ({
      byteLength: image.data.byteLength,
      mimeType: image.mimeType,
    })),
  });
  debugLog("cursor_request.build.end", payload);
  return payload;
}

// ── Server message processing ──

/**
 * Returns true when this message represents forward progress / upstream liveness
 * for the stream idle watchdog:
 *   - non-empty `textDelta` / `thinkingDelta`
 *   - `tokenDelta` (long reasoning often emits only these for minutes)
 *   - `toolCallCompleted`
 *   - any handled `execServerMessage` (MCP exec **or** native-tool reject reply)
 *   - `conversationCheckpointUpdate` with an `onCheckpoint` sink
 *   - handled KV get/set blob round-trips
 *   - handled interaction queries (e.g. WebFetch approval)
 *
 * Returns false only for empty text deltas, unhandled KV/exec/interaction cases,
 * and other noise. A true hang is silence — not token accounting or reject loops.
 */
function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onCheckpoint?: (checkpointBytes: Uint8Array) => void,
): boolean {
  const msgCase = msg.message.case;
  debugLog("server_message", { msgCase, msg });

  if (msgCase === "interactionUpdate") {
    const update = msg.message.value as any;
    const updateCase = update.message?.case;
    if (updateCase === "textDelta") {
      const delta = update.message.value.text || "";
      if (delta) {
        onText(delta, false);
        return interactionUpdateCountsAsProgress(updateCase, true);
      }
      return false;
    }
    if (updateCase === "thinkingDelta") {
      const delta = update.message.value.text || "";
      if (delta) {
        onText(delta, true);
        return interactionUpdateCountsAsProgress(updateCase, true);
      }
      return false;
    }
    if (updateCase === "tokenDelta") {
      state.outputTokens += update.message.value.tokens ?? 0;
      return interactionUpdateCountsAsProgress(updateCase);
    }
    if (updateCase === "toolCallCompleted") {
      const completed = update.message.value as any;
      const mcpToolCall =
        completed.toolCall?.tool?.case === "mcpToolCall"
          ? completed.toolCall.tool.value
          : undefined;
      const result = mcpToolCall?.result?.result;
      if (result?.case && result.case !== "success") {
        const args = mcpToolCall.args;
        const value = result.value as any;
        debugLog("native.stream.mcp_tool_error", {
          callId: completed.callId,
          modelCallId: completed.modelCallId,
          resultCase: result.case,
          toolName: args?.toolName,
          mcpName: args?.name,
          providerIdentifier: args?.providerIdentifier,
          error: value?.error ?? value?.reason,
          errorUnknown: value?.$unknown,
        });
      }
      return interactionUpdateCountsAsProgress(updateCase);
    }
    return false;
  }
  if (msgCase === "kvServerMessage") {
    return handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
  }
  if (msgCase === "execServerMessage") {
    return handleExecMessage(
      msg.message.value as ExecServerMessage,
      mcpTools,
      sendFrame,
      onMcpExec,
    );
  }
  if (msgCase === "interactionQuery") {
    const query = msg.message.value as InteractionQuery;
    const result = handleInteractionQuery(query, sendFrame);
    lifecycleLog("interaction_query", {
      id: query.id,
      queryCase: result.queryCase,
      action: result.action,
      handled: result.handled,
    });
    debugLog(
      result.handled
        ? "native.interaction_query.handled"
        : "native.interaction_query.unhandled",
      {
        id: query.id,
        queryCase: result.queryCase,
        action: result.action,
        clientVersion: process.env.PI_CURSOR_CLIENT_VERSION || "default",
      },
    );
    setLastStreamEvent(
      result.handled
        ? `interaction_query:${result.action}`
        : `interaction_query_unhandled:${result.queryCase ?? "unknown"}`,
    );
    // Treated as progress either way if we answered — prevents stall detectors from firing.
    return result.handled;
  }
  if (msgCase === "execServerControlMessage") {
    const control = msg.message.value as { message?: { case?: string } };
    const controlCase = control.message?.case;
    debugLog("native.exec_server_control", { controlCase });
    lifecycleLog("exec_server_control", { controlCase });
    // Abort notices are informational; the stream may continue or end separately.
    return controlCase === "abort";
  }
  if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if ((stateStructure as any).tokenDetails) {
      state.totalTokens = (stateStructure as any).tokenDetails.usedTokens;
    }
    if (onCheckpoint) {
      onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure));
      return true;
    }
    return false;
  }
  return false;
}

function sendKvResponse(
  kvMsg: KvServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(KvClientMessageSchema, {
    id: (kvMsg as any).id,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "kvClientMessage", value: response },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

/** Returns true when a recognized KV branch fired (real round-trip with cursor). */
function handleKvMessage(
  kvMsg: KvServerMessage,
  blobStore: Map<string, Uint8Array>,
  sendFrame: (data: Uint8Array) => void,
): boolean {
  const kvCase = (kvMsg as any).message.case;
  if (kvCase === "getBlobArgs") {
    const blobId = (kvMsg as any).message.value.blobId;
    const blobIdKey = Buffer.from(blobId).toString("hex");
    const blobData = blobStore.get(blobIdKey);
    sendKvResponse(
      kvMsg,
      "getBlobResult",
      create(GetBlobResultSchema, blobData ? { blobData } : {}),
      sendFrame,
    );
    return true;
  }
  if (kvCase === "setBlobArgs") {
    const { blobId, blobData } = (kvMsg as any).message.value;
    blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
    sendKvResponse(kvMsg, "setBlobResult", create(SetBlobResultSchema, {}), sendFrame);
    return true;
  }
  return false;
}

/**
 * Returns true when this `execServerMessage` was handled (MCP exec **or** a
 * native-tool reject/response). Handled round-trips count as idle-watchdog
 * progress so Cursor-native tool reject loops cannot stall for minutes and
 * then trip the idle timer.
 */
function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
): boolean {
  return handleExecMessageInner(execMsg, mcpTools, sendFrame, onMcpExec);
}

function handleExecMessageInner(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
): boolean {
  const execCase = (execMsg as any).message.case;
  const REJECT_REASON =
    "Tool not available in this environment. Use the MCP tools provided instead.";

  if (execCase === "requestContextArgs") {
    const requestContext = create(RequestContextSchema, {
      rules: [],
      repositoryInfo: [],
      tools: mcpTools,
      gitRepos: [],
      projectLayouts: [],
      mcpInstructions: [],
      fileContents: {},
      customSubagents: [],
    });
    const result = create(RequestContextResultSchema, {
      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext }) },
    });
    sendExecResult(execMsg, "requestContextResult", result, sendFrame);
    return true;
  }

  if (execCase === "mcpArgs") {
    const mcpArgs = (execMsg as any).message.value;
    const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
    onMcpExec({
      execId: (execMsg as any).execId,
      execMsgId: (execMsg as any).id,
      toolCallId: mcpArgs.toolCallId || crypto.randomUUID(),
      toolName: mcpArgs.toolName || mcpArgs.name,
      decodedArgs: JSON.stringify(decoded),
    });
    return true;
  }

  // Reject native Cursor tools so model falls back to MCP tools
  if (execCase === "readArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(
      execMsg,
      "readResult",
      create(ReadResultSchema, {
        result: {
          case: "rejected",
          value: create(ReadRejectedSchema, { path: args.path, reason: REJECT_REASON }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "lsArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(
      execMsg,
      "lsResult",
      create(LsResultSchema, {
        result: {
          case: "rejected",
          value: create(LsRejectedSchema, { path: args.path, reason: REJECT_REASON }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "grepArgs") {
    sendExecResult(
      execMsg,
      "grepResult",
      create(GrepResultSchema, {
        result: { case: "error", value: create(GrepErrorSchema, { error: REJECT_REASON }) },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "writeArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(
      execMsg,
      "writeResult",
      create(WriteResultSchema, {
        result: {
          case: "rejected",
          value: create(WriteRejectedSchema, { path: args.path, reason: REJECT_REASON }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "deleteArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(
      execMsg,
      "deleteResult",
      create(DeleteResultSchema, {
        result: {
          case: "rejected",
          value: create(DeleteRejectedSchema, { path: args.path, reason: REJECT_REASON }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "shellArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(
      execMsg,
      "shellResult",
      create(ShellResultSchema, {
        result: {
          case: "rejected",
          value: create(ShellRejectedSchema, {
            command: args.command ?? "",
            workingDirectory: args.workingDirectory ?? "",
            reason: REJECT_REASON,
            isReadonly: false,
          }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "shellStreamArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(
      execMsg,
      "shellStream",
      create(ShellStreamSchema, {
        event: {
          case: "rejected",
          value: create(ShellRejectedSchema, {
            command: args.command ?? "",
            workingDirectory: args.workingDirectory ?? "",
            reason: REJECT_REASON,
            isReadonly: false,
          }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "backgroundShellSpawnArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(
      execMsg,
      "backgroundShellSpawnResult",
      create(BackgroundShellSpawnResultSchema, {
        result: {
          case: "rejected",
          value: create(ShellRejectedSchema, {
            command: args.command ?? "",
            workingDirectory: args.workingDirectory ?? "",
            reason: REJECT_REASON,
            isReadonly: false,
          }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "writeShellStdinArgs") {
    sendExecResult(
      execMsg,
      "writeShellStdinResult",
      create(WriteShellStdinResultSchema, {
        result: {
          case: "error",
          value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "fetchArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(
      execMsg,
      "fetchResult",
      create(FetchResultSchema, {
        result: {
          case: "error",
          value: create(FetchErrorSchema, { url: args.url ?? "", error: REJECT_REASON }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "diagnosticsArgs") {
    sendExecResult(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {}), sendFrame);
    return true;
  }

  if (execCase === "listMcpResourcesExecArgs") {
    sendExecResult(
      execMsg,
      "listMcpResourcesExecResult",
      create(ListMcpResourcesExecResultSchema, {
        result: {
          case: "rejected",
          value: create(ListMcpResourcesRejectedSchema, { reason: REJECT_REASON }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "readMcpResourceExecArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(
      execMsg,
      "readMcpResourceExecResult",
      create(ReadMcpResourceExecResultSchema, {
        result: {
          case: "rejected",
          value: create(ReadMcpResourceRejectedSchema, {
            uri: args.uri ?? "",
            reason: REJECT_REASON,
          }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "recordScreenArgs") {
    sendExecResult(
      execMsg,
      "recordScreenResult",
      create(RecordScreenResultSchema, {
        result: {
          case: "failure",
          value: create(RecordScreenFailureSchema, { error: REJECT_REASON }),
        },
      }),
      sendFrame,
    );
    return true;
  }
  if (execCase === "computerUseArgs") {
    const args = (execMsg as any).message.value;
    sendExecResult(
      execMsg,
      "computerUseResult",
      create(ComputerUseResultSchema, {
        result: {
          case: "error",
          value: create(ComputerUseErrorSchema, {
            error: REJECT_REASON,
            actionCount: Array.isArray(args.actions) ? args.actions.length : 0,
            durationMs: 0,
          }),
        },
      }),
      sendFrame,
    );
    return true;
  }

  // Catch-all: log and attempt a generic rejection so the bridge doesn't hang
  console.error(`[cursor-provider] UNHANDLED exec case: "${execCase}". Bridge may stall.`);
  setLastStreamEvent(`unhandled_exec:${String(execCase ?? "unknown")}`);
  // Try to derive the result case name from the args case name
  const guessedResult = (execCase as string)?.replace(/Args$/, "Result");
  if (guessedResult && guessedResult !== execCase) {
    sendExecResult(execMsg, guessedResult, create(McpResultSchema, {}), sendFrame);
    return true;
  }
  return false;
}

function sendExecResult(
  execMsg: ExecServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: (execMsg as any).id,
    execId: (execMsg as any).execId,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

// ── Key derivation ──

export function derivePiSessionId(
  body: Pick<ChatCompletionRequest, "pi_session_id" | "user">,
): string | undefined {
  const raw = body.pi_session_id ?? body.user;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export function deriveBridgeKeyFromSessionId(sessionId: string): string {
  return createHash("sha256").update(`bridge:${sessionId}`).digest("hex").slice(0, 16);
}

export function deriveConversationKeyFromSessionId(sessionId: string): string {
  return createHash("sha256").update(`conv:${sessionId}`).digest("hex").slice(0, 16);
}

export function deriveBridgeKey(messages: OpenAIMessage[], sessionId?: string): string {
  if (sessionId) return deriveBridgeKeyFromSessionId(sessionId);
  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  return createHash("sha256")
    .update(`bridge:${firstUserText.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 16);
}

export function deriveConversationKey(messages: OpenAIMessage[], sessionId?: string): string {
  if (sessionId) return deriveConversationKeyFromSessionId(sessionId);
  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  return createHash("sha256")
    .update(`conv:${firstUserText.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 16);
}

export function cleanupSessionState(sessionId?: string): void {
  if (!sessionId) return;
  const bridgeKey = deriveBridgeKeyFromSessionId(sessionId);
  const convKey = deriveConversationKeyFromSessionId(sessionId);
  const active = activeBridges.get(bridgeKey);
  debugLog("session.cleanup", {
    sessionId,
    bridgeKey,
    convKey,
    hasActiveBridge: !!active,
    hadConversation: conversationStates.has(convKey),
  });
  if (active) cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  conversationStates.delete(convKey);
}

export function deterministicConversationId(convKey: string): string {
  const hex = createHash("sha256").update(`cursor-conv-id:${convKey}`).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${(0x8 | (parseInt(hex[16], 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

// ── Thinking tag filter ──

const THINKING_TAG_NAMES = ["think", "thinking", "reasoning", "thought", "think_intent"];
const MAX_THINKING_TAG_LEN = 16;
// Hoisted to module scope so it is compiled once rather than rebuilt on every
// streamed chunk. `lastIndex` is reset at the start of each process() call.
const THINKING_TAG_RE = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join("|")})\\s*>`, "gi");

function createThinkingTagFilter() {
  let buffer = "";
  let inThinking = false;
  return {
    process(text: string) {
      const input = buffer + text;
      buffer = "";
      let content = "";
      let reasoning = "";
      let lastIdx = 0;
      const re = THINKING_TAG_RE;
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index);
        if (inThinking) reasoning += before;
        else content += before;
        inThinking = match[1] !== "/";
        lastIdx = re.lastIndex;
      }
      const rest = input.slice(lastIdx);
      const ltPos = rest.lastIndexOf("<");
      if (
        ltPos >= 0 &&
        rest.length - ltPos < MAX_THINKING_TAG_LEN &&
        /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))
      ) {
        buffer = rest.slice(ltPos);
        const before = rest.slice(0, ltPos);
        if (inThinking) reasoning += before;
        else content += before;
      } else {
        if (inThinking) reasoning += rest;
        else content += rest;
      }
      return { content, reasoning };
    },
    flush() {
      const b = buffer;
      buffer = "";
      if (!b) return { content: "", reasoning: "" };
      return inThinking ? { content: "", reasoning: b } : { content: b, reasoning: "" };
    },
  };
}

// ── Connect frame helpers ──

function makeHeartbeatBytes(): Uint8Array {
  const heartbeat = create(AgentClientMessageSchema, {
    message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
  });
  return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}

function computeUsage(state: StreamState) {
  const completion_tokens = state.outputTokens;
  const total_tokens = state.totalTokens || completion_tokens;
  const prompt_tokens = Math.max(0, total_tokens - completion_tokens);
  return { prompt_tokens, completion_tokens, total_tokens };
}

function respondWithPendingToolCalls(
  modelId: string,
  pendingExecs: PendingExec[],
  stream: boolean,
  res: ServerResponse,
): void {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = pendingExecs.map((exec, index) => ({
    index,
    id: exec.toolCallId,
    type: "function" as const,
    function: { name: exec.toolName, arguments: exec.decodedArgs },
  }));

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const toolCall of toolCalls) {
      res.write(
        `data: ${JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
        })}\n\n`,
      );
    }
    res.write(
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: completionId,
      object: "chat.completion",
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: toolCalls },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
}

// ── Streaming response ──

function startBridge(accessToken: string, requestBytes: Uint8Array) {
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

function handleStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  bridgeKey: string,
  convKey: string,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
): void {
  debugLog("stream.start", { requestId, bridgeKey, convKey, modelId });
  const { bridge, heartbeatTimer } = startBridge(accessToken, payload.requestBytes);
  writeSSEStream(
    bridge,
    heartbeatTimer,
    payload.blobStore,
    payload.mcpTools,
    modelId,
    bridgeKey,
    convKey,
    completedTurns,
    currentTurn,
    req,
    res,
    requestId,
  );
}

function sendCancelAction(bridge: BridgeHandle): void {
  debugLog("bridge.cancel_action", {});
  const action = create(ConversationActionSchema, {
    action: { case: "cancelAction", value: create(CancelActionSchema, {}) },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "conversationAction", value: action },
  });
  bridge.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

function cleanupBridge(
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

function writeSSEStream(
  bridge: BridgeHandle,
  heartbeatTimer: ReturnType<typeof setInterval>,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  modelId: string,
  bridgeKey: string,
  convKey: string,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
  req: IncomingMessage,
  res: ServerResponse,
  requestId?: string,
): void {
  debugLog("stream.writer_start", {
    requestId,
    bridgeKey,
    convKey,
    modelId,
    completedTurnCount: completedTurns.length,
    currentTurn,
  });
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let closed = false;
  const sendSSE = (data: object) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const sendDone = () => {
    if (closed) return;
    res.write("data: [DONE]\n\n");
  };
  const closeResponse = () => {
    if (closed) return;
    closed = true;
    res.end();
  };

  const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  const makeUsageChunk = () => {
    const { prompt_tokens, completion_tokens, total_tokens } = computeUsage(state);
    return {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [],
      usage: { prompt_tokens, completion_tokens, total_tokens },
    };
  };

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

  // Detect client disconnect (e.g. user pressed Escape in pi)
  const onClientClose = () => {
    if (cancelled || closed) return;
    debugLog("stream.client_close", { requestId, bridgeKey, convKey });
    cancelled = true;
    cleanupBridge(bridge, heartbeatTimer, bridgeKey);
    closeResponse();
  };
  req.on("close", onClientClose);
  res.on("close", onClientClose);

  const processChunk = createConnectFrameParser(
    (messageBytes) => {
      try {
        const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
        processServerMessage(
          serverMessage,
          blobStore,
          mcpTools,
          (data) => bridge.write(data),
          state,
          (text, isThinking) => {
            if (isThinking) {
              sendSSE(makeChunk({ reasoning_content: text }));
            } else {
              const { content, reasoning } = tagFilter.process(text);
              if (reasoning) sendSSE(makeChunk({ reasoning_content: reasoning }));
              if (content) {
                appendAssistantTextToTurn(currentTurn, content);
                sendSSE(makeChunk({ content }));
              }
            }
          },
          (exec) => {
            state.pendingExecs.push(exec);
            mcpExecReceived = true;

            const flushed = tagFilter.flush();
            if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
            if (flushed.content) {
              appendAssistantTextToTurn(currentTurn, flushed.content);
              sendSSE(makeChunk({ content: flushed.content }));
            }

            currentTurn.steps.push({
              kind: "toolCall",
              toolCallId: exec.toolCallId,
              toolName: exec.toolName,
              arguments: parseToolCallArguments(exec.decodedArgs),
            });

            const toolCallIndex = state.toolCallIndex++;
            sendSSE(
              makeChunk({
                tool_calls: [
                  {
                    index: toolCallIndex,
                    id: exec.toolCallId,
                    type: "function",
                    function: { name: exec.toolName, arguments: exec.decodedArgs },
                  },
                ],
              }),
            );

            setActiveBridge(bridgeKey, {
              bridge,
              heartbeatTimer,
              blobStore,
              mcpTools,
              pendingExecs: state.pendingExecs,
              currentTurn,
            });
            debugLog("stream.tool_call_pause", {
              requestId,
              bridgeKey,
              exec,
              pendingExecs: state.pendingExecs,
              currentTurn,
            });

            sendSSE(makeChunk({}, "tool_calls"));
            sendDone();
            closeResponse();
          },
          (checkpointBytes) => {
            latestCheckpoint = checkpointBytes;
            debugLog("stream.checkpoint_buffered", { requestId, convKey, checkpointBytes });
          },
        );
      } catch (err) {
        console.error(
          "[cursor-provider] Stream message processing error:",
          err instanceof Error ? err.message : err,
        );
      }
    },
    (endStreamBytes) => {
      const endError = parseConnectEndStream(endStreamBytes);
      if (endError) {
        streamError = endError;
        console.error(`[cursor-provider] Cursor stream error (${modelId}):`, endError.message);
        sendSSE(makeChunk({ content: endError.message }, "error"));
        sendSSE(makeUsageChunk());
        sendDone();
        closeResponse();
      }
    },
  );

  bridge.onData(processChunk);

  bridge.onClose((code) => {
    debugLog("stream.bridge_close", {
      requestId,
      bridgeKey,
      convKey,
      code,
      cancelled,
      mcpExecReceived,
      currentTurn,
      latestCheckpoint,
    });
    clearInterval(heartbeatTimer);
    req.removeListener("close", onClientClose);
    res.removeListener("close", onClientClose);

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
      sendSSE(makeChunk({ content: "Bridge connection lost" }, "error"));
      sendSSE(makeUsageChunk());
      sendDone();
      closeResponse();
      removeActiveBridge(bridgeKey);
      return;
    }

    if (!mcpExecReceived) {
      const flushed = tagFilter.flush();
      if (flushed.reasoning) sendSSE(makeChunk({ reasoning_content: flushed.reasoning }));
      if (flushed.content) {
        appendAssistantTextToTurn(currentTurn, flushed.content);
        sendSSE(makeChunk({ content: flushed.content }));
      }
      if (stored) {
        if (latestCheckpoint) {
          commitStoredCheckpoint(stored, latestCheckpoint, blobStore, completedTurns, currentTurn);
          debugLog("stream.checkpoint_committed", { requestId, convKey, stored });
        } else {
          mergeBlobStore(stored, blobStore);
        }
      }
      sendSSE(makeChunk({}, "stop"));
      sendSSE(makeUsageChunk());
      sendDone();
      closeResponse();
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

export function writeSSEStreamForTests(args: {
  bridge: BridgeHandle;
  heartbeatTimer: ReturnType<typeof setInterval>;
  blobStore?: Map<string, Uint8Array>;
  mcpTools?: McpToolDefinition[];
  modelId: string;
  bridgeKey: string;
  convKey: string;
  completedTurns: ParsedTurn[];
  currentTurn: ParsedTurn;
  req: IncomingMessage;
  res: ServerResponse;
  requestId?: string;
}): void {
  writeSSEStream(
    args.bridge,
    args.heartbeatTimer,
    args.blobStore ?? new Map(),
    args.mcpTools ?? [],
    args.modelId,
    args.bridgeKey,
    args.convKey,
    args.completedTurns,
    args.currentTurn,
    args.req,
    args.res,
    args.requestId,
  );
}

// ── Tool result resume ──

function handleToolResultResume(
  active: ActiveBridge,
  toolResults: ToolResultInfo[],
  modelId: string,
  bridgeKey: string,
  convKey: string,
  completedTurns: ParsedTurn[],
  req: IncomingMessage,
  res: ServerResponse,
  stream: boolean,
  requestId?: string,
): void {
  const { bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs, currentTurn } = active;
  debugLog("tool_resume.start", {
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
    debugLog("tool_resume.partial_wait", { requestId, bridgeKey, unresolvedExecs, currentTurn });
    respondWithPendingToolCalls(modelId, unresolvedExecs, stream, res);
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
    debugLog("tool_resume.sent_result", { requestId, exec, result });
  }

  // Tool results belong to the same user turn that initiated the tool calls.
  // parseMessages keeps tool continuations out of completed history, so completedTurns
  // already reflects the correct history covered before this in-flight turn.
  writeSSEStream(
    bridge,
    heartbeatTimer,
    blobStore,
    mcpTools,
    modelId,
    bridgeKey,
    convKey,
    completedTurns,
    currentTurn,
    req,
    res,
    requestId,
  );
}

// ── Non-streaming response ──

async function handleNonStreamingResponse(
  payload: CursorRequestPayload,
  accessToken: string,
  modelId: string,
  convKey: string,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
  req: IncomingMessage,
  res: ServerResponse,
  requestId?: string,
): Promise<void> {
  debugLog("nonstream.start", {
    requestId,
    convKey,
    modelId,
    currentTurn,
    completedTurnCount: completedTurns.length,
  });
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);

  const { bridge, heartbeatTimer } = startBridge(accessToken, payload.requestBytes);
  let cancelled = false;

  const onClientClose = () => {
    if (cancelled) return;
    debugLog("nonstream.client_close", { requestId, convKey });
    cancelled = true;
    clearInterval(heartbeatTimer);
    if (bridge.alive) {
      sendCancelAction(bridge);
      bridge.end();
    }
  };
  req.on("close", onClientClose);
  res.on("close", onClientClose);
  const state: StreamState = {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
  };
  const tagFilter = createThinkingTagFilter();
  let fullText = "";
  let nonStreamError: Error | null = null;
  let latestCheckpoint: Uint8Array | null = null;

  return new Promise((resolve) => {
    bridge.onData(
      createConnectFrameParser(
        (messageBytes) => {
          try {
            const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
            processServerMessage(
              serverMessage,
              payload.blobStore,
              payload.mcpTools,
              (data) => bridge.write(data),
              state,
              (text, isThinking) => {
                if (isThinking) return;
                const { content } = tagFilter.process(text);
                fullText += content;
                appendAssistantTextToTurn(currentTurn, content);
              },
              () => {},
              (checkpointBytes) => {
                latestCheckpoint = checkpointBytes;
                debugLog("nonstream.checkpoint_buffered", { requestId, convKey, checkpointBytes });
              },
            );
          } catch (err) {
            console.error(
              "[cursor-provider] Non-stream message processing error:",
              err instanceof Error ? err.message : err,
            );
          }
        },
        (endStreamBytes) => {
          const endError = parseConnectEndStream(endStreamBytes);
          if (endError) {
            console.error(
              `[cursor-provider] Cursor non-stream error (${modelId}):`,
              endError.message,
            );
            nonStreamError = endError;
          }
        },
      ),
    );

    bridge.onClose((code) => {
      debugLog("nonstream.bridge_close", {
        requestId,
        convKey,
        code,
        cancelled,
        nonStreamError: nonStreamError?.message,
        currentTurn,
        latestCheckpoint,
      });
      clearInterval(heartbeatTimer);
      req.removeListener("close", onClientClose);
      res.removeListener("close", onClientClose);

      if (cancelled) {
        if (!res.headersSent) {
          res.writeHead(499, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "Client closed request", type: "aborted", code: "client_closed" },
            }),
          );
        }
        resolve();
        return;
      }

      if (code !== 0 && !nonStreamError) {
        nonStreamError = new Error("Bridge connection lost");
      }

      if (nonStreamError) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: nonStreamError.message,
              type: "upstream_error",
              code: "cursor_error",
            },
          }),
        );
        resolve();
        return;
      }

      const flushed = tagFilter.flush();
      fullText += flushed.content;
      appendAssistantTextToTurn(currentTurn, flushed.content);
      const usage = computeUsage(state);
      const stored = conversationStates.get(convKey);
      if (stored) {
        if (latestCheckpoint) {
          commitStoredCheckpoint(
            stored,
            latestCheckpoint,
            payload.blobStore,
            completedTurns,
            currentTurn,
          );
          debugLog("nonstream.checkpoint_committed", { requestId, convKey, stored });
        } else {
          mergeBlobStore(stored, payload.blobStore);
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: completionId,
          object: "chat.completion",
          created,
          model: modelId,
          choices: [
            { index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" },
          ],
          usage,
        }),
      );
      resolve();
    });
  });
}
