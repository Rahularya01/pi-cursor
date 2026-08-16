/**
 * Builds the `AgentRunRequest` protobuf that starts (or resumes) a Cursor turn.
 *
 * Two shapes come out of here:
 *   - a fresh request carrying the full conversation history as turn structures
 *   - a resume request carrying an upstream checkpoint blob instead
 *
 * Large payloads (images, turn-step bytes) are content-addressed into a blob
 * store and referenced by hash, which is what keeps a long session's request
 * from re-uploading every attachment on every turn.
 */
import { create, fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  AssistantMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  McpArgsSchema,
  McpImageContentSchema,
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
  SelectedContextSchema,
  SelectedImageSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  type McpToolDefinition,
  type UserMessage,
} from "../proto/agent_pb.js";
import { buildSelectedContextBlob, type CursorModelParameter } from "../client/cursor-wire.js";
import { debugLog, requestDebugByBody } from "./debug-log.js";
import type {
  CursorRequestPayload,
  OpenAIToolDef,
  ParsedImageContent,
  ParsedToolResult,
  ParsedTurn,
  ParsedTurnStep,
} from "./types.js";

export const MAX_MCP_TOOL_TEXT_BYTES = 512 * 1024;
export const MAX_MCP_TOOL_RESULT_BYTES = 16 * 1024 * 1024;

function truncateUtf8(text: string, maxBytes: number, originalBytes: number): string {
  const suffix = `\n\n[pi-cursor truncated this tool result from ${originalBytes} bytes to protect the agent context. Use a narrower command, path, or line range.]`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const bytes = Buffer.from(text, "utf8");
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + suffix;
}

/**
 * Bound a single tool response before it is journaled or encoded for Cursor.
 * An accidental recursive dump should not poison every later turn in a session.
 */
export function normalizeToolResultForTransport(
  result: Omit<ParsedToolResult, "isError"> & { isError?: boolean },
): ParsedToolResult {
  const originalTextBytes = Buffer.byteLength(result.content, "utf8");
  let content =
    originalTextBytes > MAX_MCP_TOOL_TEXT_BYTES
      ? truncateUtf8(result.content, MAX_MCP_TOOL_TEXT_BYTES, originalTextBytes)
      : result.content;

  const images: ParsedImageContent[] = [];
  let usedBytes = Buffer.byteLength(content, "utf8");
  let droppedImages = 0;
  let droppedImageBytes = 0;
  for (const image of result.images ?? []) {
    const imageBytes = image.data.byteLength + Buffer.byteLength(image.mimeType, "utf8");
    if (usedBytes + imageBytes > MAX_MCP_TOOL_RESULT_BYTES) {
      droppedImages += 1;
      droppedImageBytes += image.data.byteLength;
      continue;
    }
    images.push(image);
    usedBytes += imageBytes;
  }

  if (droppedImages > 0) {
    const notice = `\n\n[pi-cursor omitted ${droppedImages} oversized tool image(s), totaling ${droppedImageBytes} bytes, to protect the transport.]`;
    const combined = content + notice;
    const combinedBytes = Buffer.byteLength(combined, "utf8");
    content =
      combinedBytes > MAX_MCP_TOOL_TEXT_BYTES
        ? truncateUtf8(combined, MAX_MCP_TOOL_TEXT_BYTES, combinedBytes)
        : combined;
  }

  return {
    content,
    isError: result.isError === true,
    ...(images.length > 0 && { images }),
  };
}

/**
 * Whether to truncate verbose tool descriptions/parameter docs before sending
 * them to Cursor. Default ON — full Pi/MCP prose often costs tens of thousands
 * of tokens per turn without improving tool selection. Set
 * PI_CURSOR_SLIM_TOOLS=0 to keep original schemas verbatim.
 */
export function isSlimToolsEnabled(envValue = process.env.PI_CURSOR_SLIM_TOOLS): boolean {
  const raw = envValue?.trim().toLowerCase();
  if (!raw) return true;
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

const TRIVIAL_CONVERSATIONAL_TURNS = new Set([
  "hi",
  "hello",
  "hey",
  "hi there",
  "hello there",
  "hey there",
  "yo",
  "how are you",
  "whats up",
  "good morning",
  "good afternoon",
  "good evening",
  "thanks",
  "thank you",
  "thanks a lot",
  "thank you very much",
  "thx",
  "ty",
  "ok",
  "okay",
  "got it",
  "sounds good",
  "cool",
  "great",
  "nice",
  "ping",
  "what can you do",
  "what can you do for me",
  "what can you help me with",
  "who are you",
  "tell me about yourself",
]);

/**
 * Narrow allowlist for turns that cannot reasonably require a tool. Exact
 * matching is intentional: "hi, inspect src" must retain the full tool set.
 */
export function isTrivialConversationalTurn(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= 40 && TRIVIAL_CONVERSATIONAL_TURNS.has(normalized);
}

const SCHEMA_ANNOTATION_KEYS = new Set([
  "description",
  "title",
  "examples",
  "default",
  "$comment",
  "$schema",
  "$id",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/**
 * Remove prose-only JSON Schema annotations while preserving the executable
 * contract: property names, types, required fields, unions, enums and numeric /
 * string constraints. Parameter descriptions are the dominant MCP token cost;
 * the function-level description still tells the model when to choose a tool.
 */
function slimJsonSchema(value: unknown, depth = 0): unknown {
  if (value == null || depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => slimJsonSchema(item, depth + 1));
  if (typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (SCHEMA_ANNOTATION_KEYS.has(key) || child === undefined) continue;
    if (key === "additionalProperties" && child === true) continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    out[key] = slimJsonSchema(child, depth + 1);
  }
  return out;
}

function conciseToolDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) return normalized;
  const firstSentence = normalized.match(/^.{24,117}?[.!?](?:\s|$)/)?.[0]?.trim();
  return firstSentence || `${normalized.slice(0, 117)}...`;
}

/** Compact tool prose/schemas for the Cursor MCP tool surface. */
export function slimOpenAIToolsForCursor(tools: OpenAIToolDef[]): OpenAIToolDef[] {
  if (!isSlimToolsEnabled()) return tools;
  return tools.map((tool) => {
    const fn = tool.function;
    const parameters =
      fn.parameters && typeof fn.parameters === "object"
        ? (slimJsonSchema(fn.parameters) as Record<string, unknown>)
        : fn.parameters;
    return {
      ...tool,
      function: {
        ...fn,
        description: conciseToolDescription(fn.description || ""),
        ...(parameters ? { parameters } : {}),
      },
    };
  });
}

// Pi typically hands the provider the same `tools` array reference turn after turn within a
// session. Slimming (recursive schema walk + description regex) and protobuf-encoding every
// tool's schema is pure work over that array, so cache the result by array identity to skip it
// when the tool set has not changed since the last call. Keyed on isSlimToolsEnabled() too since
// that env-driven toggle can change between calls (e.g. tests, debug tooling).
const mcpToolDefinitionsCache = new WeakMap<OpenAIToolDef[], Map<boolean, McpToolDefinition[]>>();

export function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
  const slimEnabled = isSlimToolsEnabled();
  const byMode = mcpToolDefinitionsCache.get(tools);
  const cached = byMode?.get(slimEnabled);
  if (cached) return cached;
  const prepared = slimOpenAIToolsForCursor(tools);
  const result = prepared.map((t) => {
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
  const modes = byMode ?? new Map<boolean, McpToolDefinition[]>();
  modes.set(slimEnabled, result);
  mcpToolDefinitionsCache.set(tools, modes);
  return result;
}

export function summarizeRequestSize(input: {
  systemPrompt: string;
  userText: string;
  tools: OpenAIToolDef[];
  mcpTools: McpToolDefinition[];
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  turnCount?: number;
}): {
  systemChars: number;
  userChars: number;
  toolCount: number;
  toolJsonChars: number;
  mcpSchemaBytes: number;
  requestBytes: number;
  blobBytes: number;
  wireBytes: number;
  turnCount: number;
  approxInputTokens: number;
} {
  let blobBytes = 0;
  for (const bytes of input.blobStore.values()) blobBytes += bytes.byteLength;
  let mcpSchemaBytes = 0;
  for (const tool of input.mcpTools) {
    mcpSchemaBytes += tool.inputSchema?.byteLength ?? 0;
    mcpSchemaBytes += (tool.description?.length ?? 0) + (tool.name?.length ?? 0);
  }
  // `toolJsonChars` reports the raw Pi surface for comparison only. Do not add
  // it (or mcpSchemaBytes) to the estimate: the encoded schemas already live in
  // requestBytes, and the system/conversation content already lives in blobs.
  const toolJsonChars = JSON.stringify(input.tools).length;
  const systemChars = input.systemPrompt.length;
  const userChars = input.userText.length;
  const wireBytes = input.requestBytes.byteLength + blobBytes;
  // Rough UTF-8/Latin heuristic used only for diagnostics, not billing.
  const approxInputTokens = Math.round(wireBytes / 4);
  return {
    systemChars,
    userChars,
    toolCount: input.tools.length,
    toolJsonChars,
    mcpSchemaBytes,
    requestBytes: input.requestBytes.byteLength,
    blobBytes,
    wireBytes,
    turnCount: input.turnCount ?? 0,
    approxInputTokens,
  };
}

export function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value);
    return toJson(ValueSchema, parsed);
  } catch {
    // Not a protobuf Value; treat bytes as UTF-8 text for MCP tool args.
    return new TextDecoder().decode(value);
  }
}

export function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) decoded[key] = decodeMcpArgValue(value);
  return decoded;
}

export function encodeMcpArgValue(value: unknown): Uint8Array {
  try {
    return toBinary(ValueSchema, fromJson(ValueSchema, value as JsonValue));
  } catch {
    return new TextEncoder().encode(String(value));
  }
}

export function encodeMcpArgsMap(args: Record<string, unknown>): Record<string, Uint8Array> {
  const encoded: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(args)) encoded[key] = encodeMcpArgValue(value);
  return encoded;
}

export function storeAsBlob(data: Uint8Array, blobStore: Map<string, Uint8Array>): Uint8Array {
  const id = new Uint8Array(createHash("sha256").update(data).digest());
  blobStore.set(Buffer.from(id).toString("hex"), data);
  return id;
}

export function createSelectedImages(images: ParsedImageContent[]) {
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

export function createUserMessage(
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

export function buildMcpSuccessContent(result: ParsedToolResult) {
  result = normalizeToolResultForTransport(result);
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

export function buildTurnStepBytes(step: ParsedTurnStep): Uint8Array {
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

export type BuildCursorRequestImageInput =
  | ParsedImageContent
  | {
      data: string;
      mimeType: string;
    };

export interface BuildCursorRequestTurnInput extends Omit<ParsedTurn, "userImages"> {
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

export function normalizeImageInput(image: BuildCursorRequestImageInput): ParsedImageContent {
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

export function normalizeTurnInput(turn: BuildCursorRequestTurnInput): ParsedTurn {
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

export function buildCursorRequestFromParts(
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
