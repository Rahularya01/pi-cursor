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

export function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
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
