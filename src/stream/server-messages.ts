/**
 * Dispatch for everything Cursor sends back on the bidirectional stream.
 *
 * Three families arrive interleaved with assistant output and each needs a reply
 * on the same stream or the server parks waiting:
 *   - `kvServerMessage`   blob get/set against the local blob store
 *   - `execServerMessage`  tool execution — MCP calls are handed to the caller;
 *     Cursor-native tools (read/write/ls/grep/shell/fetch) run on this stream
 *   - `interactionQuery`  permission prompts, answered by ./interaction-query.ts
 *
 * Every handler returns whether it made forward progress, which is what feeds
 * the idle watchdog — see `processServerMessage` for the exact contract.
 */
import { create, toBinary } from "@bufbuild/protobuf";

import {
  AgentClientMessageSchema,
  BackgroundShellSpawnResultSchema,
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  ConversationStateStructureSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientThrowSchema,
  GetBlobResultSchema,
  KvClientMessageSchema,
  McpResultSchema,
  McpToolNotFoundSchema,
  ReadMcpResourceExecResultSchema,
  ReadMcpResourceRejectedSchema,
  RecordScreenFailureSchema,
  RecordScreenResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type ExecServerMessage,
  type InteractionQuery,
  type KvServerMessage,
  type McpToolDefinition,
} from "../proto/agent_pb.js";
import { frameConnectMessage } from "../client/bridge.js";
import { debugLog, lifecycleLog } from "./debug-log.js";
import { recordDriftSignal, recordUnknownFields } from "./drift.js";
import { dispatchNativeExec, type NativeExecFrame } from "./exec-native.js";
import { handleInteractionQuery } from "./interaction-query.js";
import { decodeMcpArgsMap } from "./request-build.js";
import {
  interactionUpdateProgress,
  MAX_ACTIVE_BLOB_BYTES,
  MAX_ACTIVE_BLOB_ENTRIES,
  MAX_INDIVIDUAL_BLOB_BYTES,
  type StreamProgress,
} from "./tuning.js";
import { markBlobMiss, trimBlobStore } from "./session-state.js";
import type { PendingExec, StreamState } from "./types.js";
import { setLastStreamEvent } from "../diagnostics/diagnostics.js";

/**
 * Classifies a server message for the stream idle watchdog.
 *
 * `work` — the run is moving: non-empty `textDelta` / `thinkingDelta`,
 * `tokenDelta` (long reasoning often emits only these for minutes), tool-call
 * events, any answered `execServerMessage` (MCP exec **or** native-tool result),
 * answered interaction queries, KV blob round-trips, checkpoints.
 *
 * `liveness` — a heartbeat. The socket is healthy; the turn may still be parked.
 *
 * `none` — empty deltas, unanswered exec/KV/interaction cases, other noise.
 */
export function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onCheckpoint?: (checkpointBytes: Uint8Array) => void,
  onExecUnanswerable?: (execCase: string | undefined) => void,
  onLocalWork?: (work: Promise<void>) => void,
): StreamProgress {
  const msgCase = msg.message.case;
  debugLog("server_message", { msgCase, msg });
  recordUnknownFields(`AgentServerMessage.${msgCase ?? "none"}`, msg);
  recordUnknownFields(`${msgCase ?? "none"}.payload`, msg.message.value);

  if (msgCase === "interactionUpdate") {
    const update = msg.message.value as any;
    const updateCase = update.message?.case;
    if (updateCase === "textDelta") {
      const delta = update.message.value.text || "";
      if (delta) {
        onText(delta, false);
        return interactionUpdateProgress(updateCase, true);
      }
      return "none";
    }
    if (updateCase === "thinkingDelta") {
      const delta = update.message.value.text || "";
      if (delta) {
        onText(delta, true);
        return interactionUpdateProgress(updateCase, true);
      }
      return "none";
    }
    if (updateCase === "tokenDelta") {
      state.outputTokens += update.message.value.tokens ?? 0;
      return interactionUpdateProgress(updateCase);
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
      return interactionUpdateProgress(updateCase);
    }
    if (updateCase === "turnEnded") {
      // Cursor closes the HTTP/2 connection right after this. Recorded so the close is
      // finalized as a completed turn instead of retried as a failure (upstream #3).
      state.turnEnded = true;
      return "work";
    }
    // Remaining cases (heartbeat, toolCallStarted, partialToolCall, ...) are already
    // classified by interactionUpdateProgress; reuse it rather than keeping a second list.
    const progress = interactionUpdateProgress(updateCase);
    if (progress !== "none") return progress;
    // Unrecognized update cases are informational rather than stranding — the
    // stream keeps flowing — but they are the first sign our schema is behind.
    recordDriftSignal("interaction_update", updateCase);
    return "none";
  }
  if (msgCase === "kvServerMessage") {
    return handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame)
      ? "work"
      : "none";
  }
  if (msgCase === "execServerMessage") {
    const execMsg = msg.message.value as ExecServerMessage;
    const execCase = (execMsg as { message?: { case?: string } }).message?.case;
    const handled = handleExecMessage(execMsg, mcpTools, sendFrame, onMcpExec, onLocalWork);
    // execServerMessage was previously invisible in the lifecycle log — the exact
    // blind spot behind unexplained mid-run stalls. Record the exec case and whether
    // we answered it, so a parked stream can be diagnosed from the sanitized log
    // alone. mcpArgs is the normal tool-call path; anything unhandled here means the
    // upstream run may park waiting for a result we never sent.
    if (execCase !== "mcpArgs") {
      lifecycleLog("exec_server", { execCase: execCase ?? "unknown", handled });
    }
    if (!handled) {
      setLastStreamEvent(`exec_unanswered:${String(execCase ?? "unknown")}`);
      recordDriftSignal("exec_message", execCase);
      onExecUnanswerable?.(execCase);
    }
    return handled ? "work" : "none";
  }
  if (msgCase === "interactionQuery") {
    const query = msg.message.value as InteractionQuery;
    const result = handleInteractionQuery(query, sendFrame, { approveWeb: true });
    lifecycleLog("interaction_query", {
      id: query.id,
      queryCase: result.queryCase,
      action: result.action,
      handled: result.handled,
    });
    debugLog(
      result.handled ? "native.interaction_query.handled" : "native.interaction_query.unhandled",
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
    if (!result.handled) {
      recordDriftSignal("interaction_query", result.queryCase);
      throw new Error(
        `Unsupported Cursor interaction query ${result.queryCase ?? "unknown"} was rejected`,
      );
    }
    return "work";
  }
  if (msgCase === "execServerControlMessage") {
    const control = msg.message.value as { message?: { case?: string } };
    const controlCase = control.message?.case;
    debugLog("native.exec_server_control", { controlCase });
    lifecycleLog("exec_server_control", { controlCase });
    // Abort notices are informational; the stream may continue or end separately.
    return controlCase === "abort" ? "work" : "none";
  }
  if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if ((stateStructure as any).tokenDetails) {
      const used = (stateStructure as any).tokenDetails.usedTokens;
      state.totalTokens = used;
      state.contextTokens = used;
    }
    if (onCheckpoint) {
      onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure));
      return "work";
    }
    return "none";
  }

  // Nothing matched: Cursor sent a server message this build has no branch for.
  // Nobody answers it, so if the run was waiting on it the turn will park until
  // the idle watchdog fires — record it so the timeout is explainable.
  recordDriftSignal("server_message", msgCase);
  return "none";
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
    if (!blobData) {
      // Cursor only asks for a blob it holds a reference to, so a miss means a
      // piece of the replayed conversation is gone. The protocol has no way to
      // say so — an empty result is indistinguishable from an empty blob — and
      // the turn continues with that history silently blank. Record it so the
      // amnesia is at least diagnosable from /cursor.doctor and the lifecycle log,
      // and invalidate the checkpoint so the next turn rebuilds from Pi history.
      lifecycleLog("kv_blob_miss", { blobId: blobIdKey.slice(0, 16), storeSize: blobStore.size });
      setLastStreamEvent("kv_blob_miss");
      markBlobMiss(blobStore);
    }
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
    const blobIdKey = Buffer.from(blobId).toString("hex");
    if (!(blobData instanceof Uint8Array)) throw new Error("Cursor sent invalid blob data");
    if (blobData.byteLength > MAX_INDIVIDUAL_BLOB_BYTES) {
      throw new Error(`Cursor blob exceeds the ${MAX_INDIVIDUAL_BLOB_BYTES} byte per-blob limit`);
    }
    // Reject blobs that cannot fit even in an empty store before any eviction, so a
    // failed write cannot punch holes in history Cursor still references.
    if (blobData.byteLength > MAX_ACTIVE_BLOB_BYTES) {
      throw new Error(`Cursor blob store exceeds the ${MAX_ACTIVE_BLOB_BYTES} byte limit`);
    }
    if (!blobStore.has(blobIdKey)) {
      const evicted = trimBlobStore(
        blobStore,
        MAX_ACTIVE_BLOB_BYTES - blobData.byteLength,
        MAX_ACTIVE_BLOB_ENTRIES - 1,
      );
      if (evicted.removed > 0) {
        debugLog("kv.blob_store_evicted", {
          removed: evicted.removed,
          totalBytes: evicted.totalBytes,
          entries: blobStore.size,
          maxEntries: MAX_ACTIVE_BLOB_ENTRIES,
        });
      }
    }
    blobStore.set(blobIdKey, blobData);
    sendKvResponse(kvMsg, "setBlobResult", create(SetBlobResultSchema, {}), sendFrame);
    return true;
  }
  recordDriftSignal("kv_message", kvCase);
  return false;
}

/**
 * Returns true when this `execServerMessage` was handled (MCP exec **or** a
 * native-tool result). Handled round-trips count as idle-watchdog progress.
 */
function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
  onLocalWork?: (work: Promise<void>) => void,
): boolean {
  return handleExecMessageInner(execMsg, mcpTools, sendFrame, onMcpExec, onLocalWork);
}

// mcpTools is fixed for the life of a stream but `mcpArgs` exec messages can arrive many times
// per turn; cache the derived name list by array identity instead of rebuilding it every call.
const availableToolNamesCache = new WeakMap<McpToolDefinition[], string[]>();

function availableToolNamesFor(mcpTools: McpToolDefinition[]): string[] {
  const cached = availableToolNamesCache.get(mcpTools);
  if (cached) return cached;
  const names = [...new Set(mcpTools.flatMap((tool) => [tool.toolName, tool.name]))].filter(
    Boolean,
  ) as string[];
  availableToolNamesCache.set(mcpTools, names);
  return names;
}

const NATIVE_EXEC_MCP_HINTS: Record<string, string[]> = {
  readArgs: ["read", "Read"],
  lsArgs: ["ls", "LS"],
  grepArgs: ["grep", "Grep"],
  writeArgs: ["write", "edit", "Edit"],
  deleteArgs: ["bash", "edit", "Edit"],
  shellArgs: ["bash"],
  shellStreamArgs: ["bash"],
  backgroundShellSpawnArgs: ["bash"],
  writeShellStdinArgs: ["bash"],
  fetchArgs: ["web_search", "fetch"],
};

function nativeToolRejectReason(execCase: string, mcpTools: McpToolDefinition[]): string {
  const available = availableToolNamesFor(mcpTools);
  const candidates = (NATIVE_EXEC_MCP_HINTS[execCase] ?? []).filter((name) =>
    available.includes(name),
  );
  if (candidates.length > 0) {
    return (
      `This native Cursor tool is not available in Pi. ` +
      `Call the MCP tool "${candidates[0]}" with the same arguments instead.`
    );
  }
  return "This native Cursor tool is not available in Pi. Use the MCP tools provided instead.";
}

function handleExecMessageInner(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
  onLocalWork?: (work: Promise<void>) => void,
): boolean {
  const execCase = (execMsg as any).message.case;
  const REJECT_REASON = nativeToolRejectReason(execCase ?? "", mcpTools);

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
    const toolName =
      typeof mcpArgs.toolName === "string" && mcpArgs.toolName
        ? mcpArgs.toolName
        : typeof mcpArgs.name === "string"
          ? mcpArgs.name
          : "";
    const availableTools = availableToolNamesFor(mcpTools);
    if (!toolName || !availableTools.includes(toolName)) {
      const notFound = create(McpResultSchema, {
        result: {
          case: "toolNotFound",
          value: create(McpToolNotFoundSchema, { name: toolName, availableTools }),
        },
      });
      sendExecResult(execMsg, "mcpResult", notFound, sendFrame);
      return true;
    }
    const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
    onMcpExec({
      execId: (execMsg as any).execId,
      execMsgId: (execMsg as any).id,
      toolCallId: mcpArgs.toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify(decoded),
    });
    return true;
  }

  const nativeArgs = ((execMsg as any).message?.value ?? {}) as Record<string, unknown>;
  const native = dispatchNativeExec(execCase ?? "", nativeArgs);
  if (native?.kind === "sync") {
    sendNativeFrame(execMsg, native.frame, sendFrame);
    return true;
  }
  if (native?.kind === "async") {
    const work = native
      .run()
      .then((frame) => sendNativeFrame(execMsg, frame, sendFrame))
      .catch((error) => {
        sendExecThrow(execMsg, error instanceof Error ? error.message : String(error), sendFrame);
      });
    onLocalWork?.(work);
    return true;
  }
  if (native?.kind === "stream") {
    const work = native
      .run((frame) => sendNativeFrame(execMsg, frame, sendFrame))
      .catch((error) => {
        sendExecThrow(execMsg, error instanceof Error ? error.message : String(error), sendFrame);
      });
    onLocalWork?.(work);
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

  // No result shape is known for an exec case this build has no branch for, and
  // guessing one is unsafe: a fabricated success is indistinguishable from having
  // actually performed a destructive operation. But silence is not the alternative
  // — Cursor parks the run on the unanswered exec id and heartbeats forever.
  // ExecClientThrow answers any exec by id without claiming a result, so the model
  // sees a failed tool instead of a dead stream.
  console.error(`[cursor-provider] UNHANDLED exec case: "${execCase}". Answering with a throw.`);
  lifecycleLog("exec_unknown_shape", {
    execCase: execCase ?? "unknown",
    unknownFields: describeUnknownFields(execMsg),
  });
  setLastStreamEvent(`unhandled_exec:${String(execCase ?? "unknown")}`);
  sendExecThrow(
    execMsg,
    `Pi's Cursor provider has no handler for exec case "${execCase ?? "unknown"}" ` +
      `(wire drift: this build's agent.proto is behind Cursor). ${REJECT_REASON}`,
    sendFrame,
  );
  return false;
}

/**
 * Field numbers, wire types and sizes of protobuf fields our schema lacks — the
 * only evidence available for identifying a new Cursor exec case, and safe to
 * keep in the always-on lifecycle log because it carries no payload content.
 */
function describeUnknownFields(message: unknown): string {
  const unknown = (
    message as { $unknown?: readonly { no: number; wireType: number; data: Uint8Array }[] }
  ).$unknown;
  if (!unknown || unknown.length === 0) return "";
  return unknown
    .map((field) => `${field.no}:wt${field.wireType}:${field.data?.byteLength ?? 0}b`)
    .join(",");
}

/**
 * The one reply that fits every exec: `ExecClientThrow` is keyed by exec id, not
 * by exec case, so it releases a parked run whose request we cannot understand.
 */
function sendExecThrow(
  execMsg: ExecServerMessage,
  error: string,
  sendFrame: (data: Uint8Array) => void,
): void {
  const control = create(ExecClientControlMessageSchema, {
    message: {
      case: "throw",
      value: create(ExecClientThrowSchema, { id: (execMsg as any).id, error }),
    },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientControlMessage", value: control },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
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

function sendNativeFrame(
  execMsg: ExecServerMessage,
  frame: NativeExecFrame,
  sendFrame: (data: Uint8Array) => void,
): void {
  sendExecResult(execMsg, frame.resultCase, frame.value, sendFrame);
}

export const __testInternals = {
  nativeToolRejectReason,
  handleExecMessageInner,
  describeUnknownFields,
  dispatchNativeExec,
};
