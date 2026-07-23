/**
 * Normalize context-mode / session side-channel user messages into the system
 * prompt so Cursor treats the real user turn as the task.
 */

export type OpenAIRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIContentPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  image_url?: { url?: string };
}

export interface OpenAIMessage {
  role: OpenAIRole;
  content?: string | OpenAIContentPart[] | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown[];
}

const CONTEXT_MODE_SIDE_CHANNEL_PRIORITY =
  "Provider infrastructure context only. Prioritize the user's actual request above. " +
  "Do not run compaction recovery, session investigation, or ctx_doctor/ctx_stats rituals " +
  "unless the user explicitly asked for that.";

export function textContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text as string)
    .join("\n");
}

export function contentHasImageParts(content: OpenAIMessage["content"]): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      part.type === "image_url" ||
      part.type === "image" ||
      (typeof part.mimeType === "string" && part.mimeType.startsWith("image/")),
  );
}

export function isContextModeSideChannelText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    /^context-mode active\b/i.test(t) ||
    t.includes("<session_state") ||
    t.includes("<session_resume") ||
    t.includes("<active_memory>") ||
    t.includes("Hierarchy: ctx_batch_execute") ||
    /<\/?session_mode\b/i.test(t)
  );
}

export function frameContextModeSideChannel(text: string): string {
  return (
    `<provider_context source="context-mode">\n${text.trim()}\n</provider_context>\n\n` +
    CONTEXT_MODE_SIDE_CHANNEL_PRIORITY
  );
}

/**
 * Fold pure side-channel user messages into the system prompt and keep the
 * real user turns as the task.
 */
export function normalizeMessagesForCursor(messages: OpenAIMessage[]): OpenAIMessage[] {
  const systemParts: string[] = [];
  const sideParts: string[] = [];
  const rest: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = textContent(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === "user") {
      const text = textContent(msg.content);
      // Keep multimodal user turns intact — only pure text side-channels move.
      if (isContextModeSideChannelText(text) && !contentHasImageParts(msg.content)) {
        sideParts.push(text);
        continue;
      }
    }

    rest.push(msg);
  }

  if (sideParts.length === 0) {
    if (systemParts.length === 0) return messages;
    return [{ role: "system", content: systemParts.join("\n") }, ...rest];
  }

  const framed = frameContextModeSideChannel(sideParts.join("\n\n"));
  const system = systemParts.length > 0 ? `${systemParts.join("\n")}\n\n${framed}` : framed;
  return [{ role: "system", content: system }, ...rest];
}
