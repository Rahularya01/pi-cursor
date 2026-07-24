/**
 * Dispatch for everything Cursor sends back on the bidirectional stream.
 *
 * Three families arrive interleaved with assistant output and each needs a reply
 * on the same stream or the server parks waiting:
 *   - `kvServerMessage`   blob get/set against the local blob store
 *   - `execServerMessage`  tool execution — MCP calls are handed to the caller,
 *     Cursor's own native tools (shell/read/write/...) get an explicit reject so
 *     the model re-plans instead of stalling
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
  DeleteRejectedSchema,
  DeleteResultSchema,
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
  McpResultSchema,
  ReadMcpResourceExecResultSchema,
  ReadMcpResourceRejectedSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RecordScreenFailureSchema,
  RecordScreenResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  ShellStreamSchema,
  WriteRejectedSchema,
  WriteResultSchema,
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
import { handleInteractionQuery } from "./interaction-query.js";
import { decodeMcpArgsMap } from "./request-build.js";
import { interactionUpdateCountsAsProgress } from "./tuning.js";
import { setLastStreamEvent } from "../diagnostics/diagnostics.js";
import type { PendingExec, StreamState } from "./types.js";

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
export function processServerMessage(
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
  recordUnknownFields(`AgentServerMessage.${msgCase ?? "none"}`, msg);
  recordUnknownFields(`${msgCase ?? "none"}.payload`, msg.message.value);

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
    // Unrecognized update cases are informational rather than stranding — the
    // stream keeps flowing — but they are the first sign our schema is behind.
    recordDriftSignal("interaction_update", updateCase);
    return false;
  }
  if (msgCase === "kvServerMessage") {
    return handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
  }
  if (msgCase === "execServerMessage") {
    const execMsg = msg.message.value as ExecServerMessage;
    const execCase = (execMsg as { message?: { case?: string } }).message?.case;
    const handled = handleExecMessage(execMsg, mcpTools, sendFrame, onMcpExec);
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
    }
    return handled;
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
    if (!result.handled) recordDriftSignal("interaction_query", result.queryCase);
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

  // Nothing matched: Cursor sent a server message this build has no branch for.
  // Nobody answers it, so if the run was waiting on it the turn will park until
  // the idle watchdog fires — record it so the timeout is explainable.
  recordDriftSignal("server_message", msgCase);
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
  recordDriftSignal("kv_message", kvCase);
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
