/**
 * Reading the system prompt and tool declarations out of a Pi context, across
 * the 0.86 transcript change.
 *
 * Up to Pi 0.85 a provider was handed a `Context` carrying `systemPrompt` and
 * `tools` as top-level fields. Pi 0.86 normalizes that into a
 * `TranscriptContext`: both now live on the transcript's *system messages*,
 * and `normalizeContext()` folds the old fields into a leading one before the
 * request reaches us. The leading system message is the prompt; every later
 * system message is a delta — `content` appends instructions, `sections`
 * replaces or removes named blocks, and `toolsAdded`/`toolsRemoved` change the
 * tool set.
 *
 * Read through the old fields alone on 0.86 and the provider sees no prompt
 * and no tools: every request goes out with a placeholder system prompt and an
 * empty tool list, which leaves the model no way to call Pi's tools.
 *
 * Pi 0.86 exports `getCurrentSystemPrompt` / `getCurrentTools` for this, but
 * importing them would raise the floor of `peerDependencies` from 0.80 to
 * 0.86 and break the package on every older host. The replay below is the
 * same algorithm, kept local, and is reached only when the legacy fields are
 * absent — so on 0.80–0.85 the original values are still used verbatim.
 *
 * Keep in sync with `packages/ai/src/utils/transcript.ts` upstream.
 */
import type { Context, Tool as PiTool } from "@earendil-works/pi-ai";

/**
 * A transcript system message. Declared structurally rather than imported:
 * `SystemMessage` is not part of the `Message` union on pre-0.86 type
 * definitions, which this package still builds against.
 */
interface TranscriptSystemMessage {
  role: "system";
  content: string | { type?: string; text?: string }[];
  sections?: Record<string, string | null>;
  toolsAdded?: PiTool[];
  toolsRemoved?: { name: string }[];
}

type AnyMessage = { role?: unknown };

function isSystemMessage(message: AnyMessage): message is TranscriptSystemMessage {
  return !!message && message.role === "system";
}

/**
 * Whether a transcript entry is a system message. Exported because pre-0.86
 * type definitions leave `"system"` out of the `Message` union, so callers
 * cannot narrow on `message.role` themselves without a type error.
 */
export function isTranscriptSystemMessage(message: unknown): boolean {
  return isSystemMessage((message ?? {}) as AnyMessage);
}

/** Text of a message body, ignoring non-text blocks. Mirrors pi-ai `contentText`. */
function contentText(content: TranscriptSystemMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * Replay every system message in order into the prompt text it leaves behind:
 * bodies are concatenated, then the surviving sections are appended in
 * declaration order. Mirrors pi-ai `getCurrentSystemPrompt`.
 */
export function transcriptSystemPrompt(messages: readonly AnyMessage[]): string {
  const bodies: string[] = [];
  const sections = new Map<string, string>();

  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    const text = contentText(message.content);
    if (text.length > 0) bodies.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }

  return [...bodies, ...sections.values()].filter((part) => part.length > 0).join("\n\n");
}

/**
 * Replay every system message in order into the tool set it leaves behind.
 * A redeclared name replaces the earlier definition but keeps its position,
 * matching pi-ai `getCurrentTools`.
 */
export function transcriptTools(messages: readonly AnyMessage[]): PiTool[] {
  const tools = new Map<string, PiTool>();

  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }

  return [...tools.values()];
}

/**
 * The system prompt for this request: the legacy field when the host still
 * sends one, otherwise the transcript replay.
 */
export function resolveContextSystemPrompt(context: Context): string {
  const legacy = context.systemPrompt;
  if (typeof legacy === "string" && legacy.length > 0) return legacy;
  return transcriptSystemPrompt(context.messages ?? []);
}

/**
 * The tools for this request: the legacy field when the host still sends a
 * non-empty one, otherwise the transcript replay.
 */
export function resolveContextTools(context: Context): PiTool[] {
  const legacy = context.tools;
  if (legacy && legacy.length > 0) return [...legacy];
  return transcriptTools(context.messages ?? []);
}
