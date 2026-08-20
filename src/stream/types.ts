/**
 * Shared type surface for the Cursor stream runtime.
 *
 * These types are pure structure with no runtime behaviour, so every stream
 * module can depend on this file without creating import cycles. Anything that
 * used to be declared twice (native-core + recovery) now lives here once.
 */
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { BridgeHandle } from "../client/bridge.js";
import type { CursorModelParameter } from "../client/cursor-wire.js";
import type { McpToolDefinition } from "../proto/agent_pb.js";
import type { CursorNativeModelRouting } from "./model-routing.js";

// ── OpenAI-shaped request surface ──
//
// Pi hands the provider an OpenAI-style context. These types describe that
// intermediate shape before it is translated into Cursor's protobuf request.

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ContentPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  image_url?: { url?: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  /** Propagated from Pi toolResult.isError into Cursor MCP results. */
  is_error?: boolean;
  /**
   * Set on a historical assistant message whose turn did not run to completion
   * (aborted, errored, truncated). Replayed into the turn as a trailing
   * assistant step — see `interruptedAssistantNotice()` in ./pi-adapter.ts.
   */
  interrupted_notice?: string;
  /** Replayed thinking from a prior assistant turn; see ./pi-adapter.ts. */
  thinking?: string;
}

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface CursorToolResultImagePayload {
  toolCallId: string;
  images: Array<{ data: string; mimeType: string }>;
}

export interface ChatCompletionRequest {
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

// ── Parsed conversation history ──

export interface ParsedImageContent {
  data: Uint8Array;
  mimeType: string;
}

export interface ParsedToolResult {
  content: string;
  isError: boolean;
  images?: ParsedImageContent[];
}

export interface ParsedAssistantTextStep {
  kind: "assistantText";
  text: string;
}

export interface ParsedThinkingStep {
  kind: "thinking";
  text: string;
}

export interface ParsedToolCallStep {
  kind: "toolCall";
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: ParsedToolResult;
}

export type ParsedTurnStep = ParsedAssistantTextStep | ParsedThinkingStep | ParsedToolCallStep;

export interface ParsedTurn {
  userText: string;
  steps: ParsedTurnStep[];
  userImages?: ParsedImageContent[];
}

export interface ToolResultInfo {
  toolCallId: string;
  content: string;
  images?: ParsedImageContent[];
  isError?: boolean;
}

export interface ParsedMessages {
  systemPrompt: string;
  userText: string;
  userImages: ParsedImageContent[];
  turns: ParsedTurn[];
  toolResults: ToolResultInfo[];
  inFlightTurn?: ParsedTurn;
}

// ── Wire request payloads ──

export interface CursorRequestPayload {
  requestBytes: Uint8Array;
  requestBody: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
}

export interface CursorRequestDebugSummary {
  systemPrompt: string;
  selectedImages: Array<{ byteLength: number; mimeType: string }>;
}

// ── Session / bridge state ──

export interface PendingExec {
  execId: string;
  execMsgId: number;
  toolCallId: string;
  toolName: string;
  decodedArgs: string;
}

/**
 * Latest upstream checkpoint for a bridge, held by reference so it survives a tool pause.
 *
 * Each resume re-enters the stream writer with fresh locals, but the bridge — and the frames
 * still arriving on it — outlive that boundary. A checkpoint delivered during a pause would be
 * stranded in the previous round's closure without a shared cell.
 */
export interface CheckpointRef {
  current: Uint8Array | null;
}

/**
 * Pi's view of the turn in flight, as opposed to the wire history sent upstream.
 * Behaviour lives in ./client-transcript.ts.
 */
export type ClientTranscript =
  | { kind: "live"; completedTurns: ParsedTurn[] }
  | { kind: "recovered"; completedTurns: ParsedTurn[]; inFlightTurn: ParsedTurn };

export interface ActiveBridge {
  bridge: BridgeHandle;
  heartbeatTimer: ReturnType<typeof setInterval>;
  toolTimeoutTimer?: ReturnType<typeof setTimeout>;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  pendingExecs: PendingExec[];
  currentTurn: ParsedTurn;
  checkpointRef: CheckpointRef;
  state: StreamState;
  /** Fingerprint of the completed turns this bridge was parked on; guards against key collisions. */
  historyFingerprint: string;
  /** Pi's completed-turn history when the wire current turn is synthetic after recovery. */
  clientTranscript?: ClientTranscript;
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
  /** Hash of the system prompt last published to Cursor for this conversation. */
  systemPromptHash?: string;
  sessionScoped: boolean;
  sessionId?: string;
  blobStore: Map<string, Uint8Array>;
  lastAccessMs: number;
}

export interface StreamState {
  toolCallIndex: number;
  pendingExecs: PendingExec[];
  outputTokens: number;
  totalTokens: number;
  /** Set once Cursor reported `turnEnded`; a connection close after it is a completed turn. */
  turnEnded: boolean;
}

// ── Native streamSimple runtime ──

export interface CursorNativeStreamConfig {
  /**
   * Declared as a property rather than a method: the runtime passes this
   * reference on to the idle-retry path, so it must not depend on `this`.
   */
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  getNoReasoningEffortByModelId?(): Map<string, string>;
  getRawModelRoutingByModelId?(): Map<string, Record<string, CursorNativeModelRouting>>;
}

export type CursorNativeStreamOptions = SimpleStreamOptions & {
  toolChoice?: unknown;
};

export type NativeBlockKind = "text" | "thinking";

export interface NativeStreamWriter {
  output: AssistantMessage;
  closed: boolean;
  start(): void;
  text(delta: string): void;
  thinking(delta: string): void;
  toolCall(exec: PendingExec): void;
  done(reason: "stop" | "length" | "toolUse", state?: StreamState): void;
  error(message: string, reason: "error" | "aborted", state?: StreamState): void;
}

export interface IdleRestartContext {
  /** True when text/thinking was already pushed to the Pi writer. */
  emittedUserVisibleContent: boolean;
  latestCheckpoint: Uint8Array | null;
  blobStore: Map<string, Uint8Array>;
  completedTurns: ParsedTurn[];
  currentTurn: ParsedTurn;
}

export interface StreamIdleRetryController {
  currentAttempt: number;
  maxRetries: number;
  recoverBeforeRetry?: boolean;
  restart(nextAttempt: number, context: IdleRestartContext): boolean;
}

export interface NativeStreamAttemptInput {
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
  /** Pi's transcript when `completedTurns`/`currentTurn` are a recovered wire view. */
  clientTranscript?: ClientTranscript;
  writer: NativeStreamWriter;
  options?: CursorNativeStreamOptions;
  requestId?: string;
  maxIdleRetries?: number;
  streamIdleTimeoutMs?: number;
  getAccessToken?: (options?: { forceRefresh?: boolean }) => Promise<string>;
  /** When true, idle timeout tries recovery/rebuild before a blind restart. */
  recoverBeforeRetry?: boolean;
  /** Required for checkpoint-based continuation after transport loss. */
  systemPrompt?: string;
  conversationId?: string;
  maxMode?: boolean;
  cursorModelParameters?: CursorModelParameter[];
}
