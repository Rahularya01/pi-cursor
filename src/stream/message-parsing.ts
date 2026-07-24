/**
 * Turns Pi's OpenAI-shaped message list into the turn structure Cursor expects.
 *
 * Cursor's agent protocol is turn-oriented (user text + assistant steps + tool
 * results), not a flat message array, so this module regroups messages into
 * `ParsedTurn`s, reattaches tool-result images to the call that produced them,
 * and folds context-mode side-channel messages into the system prompt.
 */
import {
  frameContextModeSideChannel as frameContextModeSideChannelImpl,
  isContextModeSideChannelText as isContextModeSideChannelTextImpl,
  normalizeMessagesForCursor as normalizeMessagesForCursorImpl,
  type OpenAIMessage as NormalizedOpenAIMessage,
} from "./context-normalize.js";
import { debugLog } from "./debug-log.js";
import {
  decodeBase64Image,
  mergeImages,
  parseImageDataUrl,
  type ImageDecodeOptions,
} from "./images.js";
import { stripInFlightResults as stripInFlightResultsImpl } from "./recovery.js";
import type {
  CursorToolResultImagePayload,
  OpenAIMessage,
  ParsedImageContent,
  ParsedMessages,
  ParsedToolCallStep,
  ParsedToolResult,
  ParsedTurn,
  ParsedTurnStep,
  ToolResultInfo,
} from "./types.js";

export function textContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

export function contentHasImageParts(content: OpenAIMessage["content"]): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        (part.type === "image_url" && !!part.image_url?.url) ||
        (part.type === "image" && !!part.data && !!part.mimeType),
    )
  );
}

export function imageContent(
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

export function parseToolResultImagePayloads(
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

export function isSyntheticToolResultImageMessage(msg: OpenAIMessage): boolean {
  return (
    msg.role === "user" &&
    textContent(msg.content).trim() === "Attached image(s) from tool result:" &&
    contentHasImageParts(msg.content)
  );
}

export type ToolCallStepWithResult = ParsedToolCallStep & { result: ParsedToolResult };

export function isToolCallStepWithResult(step: ParsedTurnStep): step is ToolCallStepWithResult {
  return step.kind === "toolCall" && step.result !== undefined;
}

export function attachSyntheticToolResultImages(
  turn: ParsedTurn,
  images: ParsedImageContent[],
): void {
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

export function normalizeToolResultText(
  content: string,
  images: ParsedImageContent[] | undefined,
): string {
  return images?.length && content.trim() === "(see attached image)" ? "" : content;
}

export function parseToolCallArguments(raw: string): Record<string, unknown> {
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

export function isToolCallStep(step: ParsedTurnStep): step is ParsedToolCallStep {
  return step.kind === "toolCall";
}

export function getTurnToolCallResults(turn: ParsedTurn): Map<string, ParsedToolResult> {
  const results = new Map<string, ParsedToolResult>();
  for (const step of turn.steps) {
    if (step.kind === "toolCall" && step.result) results.set(step.toolCallId, step.result);
  }
  return results;
}

export function appendAssistantTextToTurn(turn: ParsedTurn, text: string): void {
  if (!text) return;
  const last = turn.steps.at(-1);
  if (last?.kind === "assistantText") {
    last.text += text;
  } else {
    turn.steps.push({ kind: "assistantText", text });
  }
}

export function stripTurnRuntimeState(
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

export function clonePlainValue(value: unknown): unknown {
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

export function stripInFlightResults(turn: ParsedTurn): ParsedTurn {
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
