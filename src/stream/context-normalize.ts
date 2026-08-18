/**
 * Normalize context-mode / session side-channel user messages into the system
 * prompt so Cursor treats the real user turn as the task.
 *
 * Important: context-mode often appends injection text to the *same* user
 * message as the real prompt ("hi\n\ncontext-mode active..."). Treating the
 * whole message as side-channel swallows the real request. Mixed messages are
 * split so only the infrastructure blocks move to the system prompt.
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
  /** Carried through untouched; see OpenAIMessage in ./types.ts. */
  interrupted_notice?: string;
  /** Replayed thinking from a prior assistant turn. */
  thinking?: string;
}

const CONTEXT_MODE_SIDE_CHANNEL_PRIORITY =
  "Provider infrastructure context only. The latest user message is the only task. " +
  "Do not continue prior work, re-read files, or run compaction/session recovery " +
  "unless the latest user message explicitly asks for that.";

const RESUME_CONTEXT_PRIORITY =
  "This block is the recovered conversation context from a resumed or compacted session. " +
  "Treat it as active memory of prior work and continue from it. " +
  "The latest user message is the current instruction, not a new unrelated task.";

/** Markers that begin a side-channel block inside an otherwise normal user turn. */
const SIDE_CHANNEL_BLOCK_START =
  /(?:^|\n)[ \t]*(?:context-mode active\b|\[context\]|\[pi-lens automated\b|<session_state\b|<session_resume\b|<active_memory\b|<compaction\b|<session_mode\b|Hierarchy:\s*ctx_batch_execute)/i;

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
    /^\[context\]/i.test(t) ||
    /(?:^|\n)[ \t]*\[pi-lens automated\b/i.test(t) ||
    t.includes("<session_state") ||
    t.includes("<session_resume") ||
    t.includes("<active_memory>") ||
    t.includes("<compaction") ||
    t.includes("context_mode") ||
    t.includes("Hierarchy: ctx_batch_execute") ||
    /<\/?session_mode\b/i.test(t)
  );
}

/**
 * True when the entire message is infrastructure-only (no residual user task).
 * Mixed messages that *contain* side-channel markers still return false here if
 * there is leading/trailing user text after splitting.
 */
export function isPureContextModeSideChannelText(text: string): boolean {
  if (!isContextModeSideChannelText(text)) return false;
  const { userText, sideText } = splitUserTextAndSideChannel(text);
  return !userText.trim() && !!sideText.trim();
}

/**
 * True when a side-channel carries no useful session memory — only the standard
 * context-mode hierarchy blurb and/or an empty/mode-only session_state.
 * These add tokens without helping the model and should be dropped.
 */
export function isNoOpSideChannelText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (!isContextModeSideChannelText(t)) return false;

  let rest = t;
  // Strip standard hierarchy boilerplate lines.
  rest = rest
    .replace(/^context-mode active\b[^\n]*$/gim, "")
    .replace(/^Read\/edit files[^\n]*$/gim, "")
    .replace(/^Multi-command research[^\n]*$/gim, "")
    .replace(/^Hierarchy:\s*ctx_batch_execute[^\n]*$/gim, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  // Strip session_state blocks that only carry mode / empty shells.
  rest = rest
    .replace(/<session_state\b[^>]*>[\s\S]*?<\/session_state>/gi, (block) => {
      if (sideChannelHasResumeMemory(block)) return block;
      const inner = block
        .replace(/<\/?session_state\b[^>]*>/gi, "")
        .replace(/<session_mode\b[^>]*>[\s\S]*?<\/session_mode>/gi, "")
        .replace(/<\/?(summary|turns|messages|memory)\b[^>]*>/gi, "")
        .trim();
      // Keep the block if it still has meaningful payload text.
      return inner.length >= 40 ? block : "";
    })
    .replace(/\n{2,}/g, "\n")
    .trim();

  return rest.length < 24;
}

/**
 * Split a user message that may concatenate real task text with context-mode /
 * session_state injections.
 */
export function splitUserTextAndSideChannel(text: string): {
  userText: string;
  sideText: string;
} {
  const raw = text ?? "";
  if (!raw.trim()) return { userText: "", sideText: "" };

  if (!isContextModeSideChannelText(raw)) {
    return { userText: raw, sideText: "" };
  }

  const match = SIDE_CHANNEL_BLOCK_START.exec(raw);
  if (!match || match.index === undefined) {
    // Marker mentioned mid-prose (e.g. "what is a <session_state> block?") — keep
    // the whole string as the user task rather than swallowing it.
    return { userText: raw, sideText: "" };
  }

  const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
  let userText = raw.slice(0, start).trim();
  let sideText = raw.slice(start).trim();

  // Side channel first, user task after the closing session_state block.
  if (!userText && sideText) {
    const closeIdx = sideText.toLowerCase().lastIndexOf("</session_state>");
    if (closeIdx >= 0) {
      const after = sideText.slice(closeIdx + "</session_state>".length).trim();
      if (after && !isContextModeSideChannelText(after)) {
        userText = after;
        sideText = sideText.slice(0, closeIdx + "</session_state>".length).trim();
      }
    }
  }

  // If the "user" residue is still only infrastructure, drop it.
  if (userText && isPureSideResidue(userText)) {
    sideText = [sideText, userText].filter(Boolean).join("\n\n");
    userText = "";
  }

  // No recoverable user task and the message looks like a full injection dump.
  if (!userText && sideText) {
    return { userText: "", sideText };
  }

  return { userText, sideText };
}

function isPureSideResidue(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (isContextModeSideChannelText(t) && t.length > 80) return true;
  // Single-line tool hierarchy leftovers.
  if (/^Hierarchy:\s*ctx_/i.test(t)) return true;
  if (/^Read\/edit files/i.test(t)) return true;
  return false;
}

/**
 * True when a side-channel carries a compaction summary or session-resume memory
 * that the model must treat as prior work, not as disposable infrastructure.
 */
export function isResumeOrCompactionSideChannel(text: string): boolean {
  if (/<session_resume\b/i.test(text)) return true;
  const summary = text.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1]?.trim() ?? "";
  if (summary.length >= 8) return true;
  const memory =
    text.match(/<active_memory\b[^>]*>([\s\S]*?)<\/active_memory>/i)?.[1]?.trim() ?? "";
  return memory.length >= 8;
}

function sideChannelHasResumeMemory(text: string): boolean {
  return isResumeOrCompactionSideChannel(text);
}

/** True when the system prompt holds folded session/compaction memory that a greeting must not drop. */
export function systemPromptHasSessionMemory(systemPrompt: string): boolean {
  const t = systemPrompt ?? "";
  if (!t) return false;
  return (
    /<provider_context\b/i.test(t) ||
    /<session_state\b/i.test(t) ||
    /<session_resume\b/i.test(t) ||
    /<active_memory\b/i.test(t)
  );
}

export function frameContextModeSideChannel(text: string): string {
  const priority = isResumeOrCompactionSideChannel(text)
    ? RESUME_CONTEXT_PRIORITY
    : CONTEXT_MODE_SIDE_CHANNEL_PRIORITY;
  return (
    `<provider_context source="context-mode">\n${text.trim()}\n</provider_context>\n\n` + priority
  );
}

function rebuildUserContent(
  original: OpenAIMessage["content"],
  userText: string,
): OpenAIMessage["content"] {
  if (!Array.isArray(original)) return userText;

  const imageParts = original.filter(
    (part) =>
      part.type === "image_url" ||
      part.type === "image" ||
      (typeof part.mimeType === "string" && part.mimeType.startsWith("image/")),
  );
  if (imageParts.length === 0) return userText;
  return [{ type: "text", text: userText }, ...imageParts];
}

/**
 * Fold pure side-channel user messages into the system prompt and keep the
 * real user turns as the task. Mixed user messages are split in place.
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
      if (!text.trim()) {
        rest.push(msg);
        continue;
      }

      const { userText, sideText } = splitUserTextAndSideChannel(text);

      if (sideText && !isNoOpSideChannelText(sideText)) sideParts.push(sideText);

      if (!userText.trim()) {
        // Pure side-channel (optionally keep images on a stub user turn).
        if (contentHasImageParts(msg.content)) {
          rest.push({
            ...msg,
            content: rebuildUserContent(msg.content, ""),
          });
        }
        continue;
      }

      if (sideText) {
        rest.push({
          ...msg,
          content: rebuildUserContent(msg.content, userText),
        });
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
  // Put the real task framing *after* infrastructure context so models that
  // overweight the end of the system prompt still see the priority rule last.
  const system = systemParts.length > 0 ? `${systemParts.join("\n")}\n\n${framed}` : framed;
  return [{ role: "system", content: system }, ...rest];
}
