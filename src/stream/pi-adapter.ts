/**
 * Translation between Pi's context/model types and the OpenAI-shaped request
 * this provider builds Cursor calls from.
 *
 * Everything Pi-facing lives here: content-block narrowing, tool definitions,
 * usage/cost accounting on the assistant message, and reasoning-effort routing
 * onto Cursor's model variants. Nothing in this module touches the wire.
 */
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent as PiImageContent,
  Message as PiMessage,
  Model,
  TextContent as PiTextContent,
  Tool as PiTool,
  ToolCall as PiToolCall,
} from "@earendil-works/pi-ai";

import { redactSecrets } from "../utils/security.js";
import type { CursorNativeModelRouting } from "./model-routing.js";
import type {
  ChatCompletionRequest,
  ContentPart,
  CursorNativeStreamConfig,
  CursorNativeStreamOptions,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIToolDef,
  StreamState,
} from "./types.js";

export function emptyCursorUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function tokenCost(tokens: number, ratePerMillion = 0): number {
  return (tokens * ratePerMillion) / 1_000_000;
}

export function applyCursorUsage(
  output: AssistantMessage,
  model: Model<Api>,
  state?: StreamState,
): void {
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

export function createCursorAssistantMessage(model: Model<Api>): AssistantMessage {
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

export function isPiTextContent(block: unknown): block is PiTextContent {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
}

export function isPiImageContent(block: unknown): block is PiImageContent {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

export function isPiToolCall(block: unknown): block is PiToolCall {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall";
}

export function isPiThinkingContent(
  block: unknown,
): block is { type: "thinking"; thinking: string } {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "thinking" &&
    typeof (block as { thinking?: unknown }).thinking === "string"
  );
}

export function piContentToOpenAIContent(
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

export function assistantTextFromPiContent(content: AssistantMessage["content"]): string {
  return content
    .filter((block): block is PiTextContent => isPiTextContent(block))
    .map((block) => block.text)
    .join("\n");
}

export function assistantThinkingFromPiContent(content: AssistantMessage["content"]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(isPiThinkingContent)
    .map((block) => block.thinking)
    .filter(Boolean)
    .join("\n");
}

export function assistantToolCallsFromPiContent(
  content: AssistantMessage["content"],
): OpenAIToolCall[] {
  return content.filter(isPiToolCall).map((block) => ({
    id: block.id,
    type: "function" as const,
    function: {
      name: block.name,
      arguments: JSON.stringify(block.arguments ?? {}),
    },
  }));
}

/** Longest error detail carried into the replayed notice. */
export const MAX_INTERRUPTED_NOTICE_ERROR_CHARS = 200;

const INTERRUPTED_NOTICE_TAIL = "the output above is incomplete and nothing further was produced";

/**
 * Describe a prior assistant turn that never ran to completion.
 *
 * Cursor's turn structure only carries the text a turn produced, so an aborted
 * or failed turn replays as one that simply trails off — indistinguishable from
 * a model that chose to stop. Observed effect on a resumed session: the model
 * reads the gap as missing context and goes looking for it (re-listing the
 * workspace, reading unrelated transcripts) instead of continuing the work.
 *
 * Returns "" for turns that completed normally, which is the common case.
 */
export function interruptedAssistantNotice(message: {
  stopReason?: AssistantMessage["stopReason"];
  errorMessage?: string;
}): string {
  const reason = message.stopReason;
  if (reason === "aborted") {
    return `[pi-cursor: this assistant turn was interrupted before it finished; ${INTERRUPTED_NOTICE_TAIL}.]`;
  }
  if (reason === "error") {
    // errorMessage is provider text and can carry a token; redact before it
    // lands in a request body, and bound it so a huge error cannot dominate
    // the replayed history.
    const raw = redactSecrets((message.errorMessage ?? "").replace(/\s+/g, " ").trim());
    const detail =
      raw.length > MAX_INTERRUPTED_NOTICE_ERROR_CHARS
        ? `${raw.slice(0, MAX_INTERRUPTED_NOTICE_ERROR_CHARS - 1)}…`
        : raw;
    return detail
      ? `[pi-cursor: this assistant turn ended with an error before it finished (${detail}); ${INTERRUPTED_NOTICE_TAIL}.]`
      : `[pi-cursor: this assistant turn ended with an error before it finished; ${INTERRUPTED_NOTICE_TAIL}.]`;
  }
  if (reason === "length") {
    return `[pi-cursor: this assistant turn was cut off at the model's output limit; ${INTERRUPTED_NOTICE_TAIL}.]`;
  }
  if (reason === "pending") {
    return `[pi-cursor: this assistant turn never completed; ${INTERRUPTED_NOTICE_TAIL}.]`;
  }
  return "";
}

export function piToolToOpenAI(tool: PiTool): OpenAIToolDef {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  };
}

export function resolveNativeReasoningEffort(
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

export function applyNativeCursorRouting(
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

export function contextToCursorChatCompletionRequest(
  model: Model<Api>,
  context: Context,
  options: CursorNativeStreamOptions | undefined,
  config: CursorNativeStreamConfig,
): ChatCompletionRequest {
  const messages: OpenAIMessage[] = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });

  for (const [index, message] of context.messages.entries()) {
    if (message.role === "user") {
      messages.push({ role: "user", content: piContentToOpenAIContent(message.content) });
      continue;
    }

    if (message.role === "assistant") {
      const tool_calls = assistantToolCallsFromPiContent(message.content);
      const thinking = assistantThinkingFromPiContent(message.content);
      // Only annotate turns that are genuinely history. A trailing aborted
      // assistant message is the turn being retried, not context behind us —
      // annotating it would turn an empty-step turn into a non-empty one and
      // strand the live user text.
      const interrupted_notice =
        index < context.messages.length - 1 ? interruptedAssistantNotice(message) : "";
      messages.push({
        role: "assistant",
        content: assistantTextFromPiContent(message.content),
        ...(tool_calls.length > 0 ? { tool_calls } : {}),
        ...(thinking ? { thinking } : {}),
        ...(interrupted_notice ? { interrupted_notice } : {}),
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

export function nativeRequestParameterError(body: ChatCompletionRequest): string | undefined {
  if (body.temperature !== undefined)
    return "Unsupported Cursor provider parameter(s): temperature";
  return undefined;
}

export function resolveToolsForToolChoice(
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

export function computeUsage(state: StreamState) {
  const completion_tokens = state.outputTokens;
  const contextTokens = state.contextTokens ?? 0;
  const total_tokens = state.totalTokens || Math.max(contextTokens, completion_tokens);
  const prompt_tokens =
    contextTokens > 0 ? Math.max(0, contextTokens) : Math.max(0, total_tokens - completion_tokens);
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: Math.max(total_tokens, prompt_tokens + completion_tokens),
  };
}
