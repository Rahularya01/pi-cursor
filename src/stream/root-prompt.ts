/**
 * Builds the model-facing prompt messages Cursor actually reads.
 *
 * Cursor's agent server assembles the prompt it sends to the model from
 * `ConversationStateStructure.root_prompt_messages_json` — a list of blob ids,
 * each holding one JSON message in the AI-SDK "model message" shape. Everything
 * else the client sends is conversation *state*: `turns` drive Cursor's own UI
 * and checkpointing, and the server never renders them back into prompt
 * messages. A request that carries history only as `turns` therefore reaches
 * the model as a single fresh user question, which is what made a resumed or
 * rebuilt conversation lose every earlier turn.
 *
 * Two shapes matter here and are verified against captured server checkpoints:
 *
 *   - The server drops `{"role":"system",...}` entries and uses its own system
 *     prompt, so Pi's system prompt has to ride a *user* message. Cursor does
 *     the same thing with its own `<rules>` block.
 *   - Assistant tool calls / tool results replay as `tool-call` and
 *     `tool-result` content parts, with MCP tool names in Cursor's
 *     `mcp_<provider>_<tool>` form.
 *
 * Only used when a request is built without an upstream checkpoint. With a
 * checkpoint the server already holds the rendered history and appends to it.
 */
import { createHash } from "node:crypto";

import type { ParsedTurn, ParsedTurnStep, ParsedToolCallStep } from "./types.js";

/** Provider identifier used when registering Pi's tools as Cursor MCP tools. */
const MCP_PROVIDER_IDENTIFIER = "pi";

/**
 * Replayed tool results are already bounded by `normalizeToolResultForTransport`
 * on the turn-structure path. Bound them again here so a long history cannot
 * blow the prompt on its own.
 */
export const MAX_REPLAYED_TOOL_RESULT_CHARS = 20_000;

export interface RootPromptTextPart {
  type: "text";
  text: string;
}

export interface RootPromptToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface RootPromptToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: string;
  isError?: boolean;
}

export type RootPromptMessage =
  | { role: "user"; content: RootPromptTextPart[] }
  | { role: "assistant"; content: Array<RootPromptTextPart | RootPromptToolCallPart> }
  | { role: "tool"; content: RootPromptToolResultPart[] };

/** Cursor namespaces MCP tools as `mcp_<providerIdentifier>_<toolName>`. */
export function cursorMcpToolName(toolName: string): string {
  const name = toolName.trim();
  if (!name) return `mcp_${MCP_PROVIDER_IDENTIFIER}_tool`;
  if (name.startsWith(`mcp_${MCP_PROVIDER_IDENTIFIER}_`)) return name;
  return `mcp_${MCP_PROVIDER_IDENTIFIER}_${name}`;
}

/** One name space for Pi tools, shared by every catalog, prompt and dispatch path. */
export interface CursorMcpToolNames {
  /** Name sent in the RunRequest/RequestContext catalogs. Never carries the `mcp_pi_` prefix. */
  wire: (name: string) => string;
  /** Name the model sees and calls: always `mcp_pi_` + the wire name. */
  advertised: (name: string) => string;
  /** Registry name for a model-issued call, or undefined when no tool owns the name. */
  resolve: (toolName: string) => string | undefined;
}

const MCP_TOOL_PREFIX = `mcp_${MCP_PROVIDER_IDENTIFIER}_`;
const toolNamesCache = new WeakMap<readonly string[], CursorMcpToolNames>();

/**
 * Builds the registry -> wire -> advertised mapping. Cursor may or may not prefix a catalog name
 * again, so wire names never carry the prefix: then `mcp_pi_<wire>` is the model-facing name on
 * every path, and wire names (unprefixed) and advertised names (prefixed) cannot collide.
 * Unprefixed registry names keep themselves; a prefixed one (custom `mcp_pi_bash`) drops the
 * prefix and takes `bash`, or `bash_2`, `bash_3`, ... when that is already claimed.
 */
export function cursorMcpToolNames(registered: readonly string[]): CursorMcpToolNames {
  const cached = toolNamesCache.get(registered);
  if (cached) return cached;
  const wireByName = new Map<string, string>();
  const nameByWire = new Map<string, string>();
  const claim = (name: string, wire: string) => {
    wireByName.set(name, wire);
    nameByWire.set(wire, name);
  };
  for (const name of registered) if (!name.startsWith(MCP_TOOL_PREFIX)) claim(name, name);
  for (const name of registered) {
    if (wireByName.has(name)) continue;
    let base = name;
    while (base.startsWith(MCP_TOOL_PREFIX)) base = base.slice(MCP_TOOL_PREFIX.length);
    base ||= "tool";
    let wire = base;
    for (let n = 2; nameByWire.has(wire); n++) wire = `${base}_${n}`;
    claim(name, wire);
  }
  const byAdvertised = (name: string) =>
    name.startsWith(MCP_TOOL_PREFIX)
      ? nameByWire.get(name.slice(MCP_TOOL_PREFIX.length))
      : undefined;
  const names: CursorMcpToolNames = {
    wire: (name) => wireByName.get(name.trim()) ?? name.trim(),
    advertised: (name) => {
      const wire = wireByName.get(name.trim());
      // A replayed call to a tool no longer registered keeps the plain prefixed form.
      return wire ? `${MCP_TOOL_PREFIX}${wire}` : cursorMcpToolName(name);
    },
    resolve: (toolName) => {
      const name = toolName.trim();
      // Advertised and wire names are exact; a prefixed registry name that is neither is still
      // accepted verbatim. Then names carrying one prefix too many: `mcp_pi_` + a registry name
      // (how Cursor rendered a prefixed custom tool before wire names, so older history may
      // carry it), else `mcp_pi_` + an advertised name. Each step is one-to-one and only sees
      // names the earlier steps left unclaimed.
      const unprefixed = name.startsWith(MCP_TOOL_PREFIX)
        ? name.slice(MCP_TOOL_PREFIX.length)
        : undefined;
      return (
        byAdvertised(name) ??
        nameByWire.get(name) ??
        [name, unprefixed].find((candidate) => candidate && registered.includes(candidate)) ??
        (unprefixed ? byAdvertised(unprefixed) : undefined)
      );
    },
  };
  toolNamesCache.set(registered, names);
  return names;
}

function truncateReplayedResult(text: string): string {
  if (text.length <= MAX_REPLAYED_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_REPLAYED_TOOL_RESULT_CHARS)}\n\n[pi-cursor truncated this replayed tool result.]`;
}

/**
 * Pi's system prompt, framed the way Cursor frames its own instructions.
 * A `system` role entry here is discarded by the server.
 */
export function systemPromptRootMessage(systemPrompt: string): RootPromptMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `<rules>\n${systemPrompt}\n</rules>` }],
  };
}

function isToolCallStep(step: ParsedTurnStep): step is ParsedToolCallStep {
  return step.kind === "toolCall";
}

/** Render one completed turn as the user / assistant / tool messages Cursor renders. */
export function turnRootMessages(
  turn: ParsedTurn,
  registeredToolNames: readonly string[] = [],
): RootPromptMessage[] {
  const messages: RootPromptMessage[] = [];
  const toolNames = cursorMcpToolNames(registeredToolNames);
  const userText = turn.userText.trim();
  const imageNote = turn.userImages?.length
    ? `\n\n[${turn.userImages.length} image attachment(s) from this earlier turn are not replayed.]`
    : "";
  if (userText || imageNote) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `<user_query>\n${userText}${imageNote}\n</user_query>` }],
    });
  }

  const assistantContent: Array<RootPromptTextPart | RootPromptToolCallPart> = [];
  const pendingResults: RootPromptToolResultPart[] = [];
  const flushAssistant = (): void => {
    if (assistantContent.length > 0) {
      messages.push({ role: "assistant", content: [...assistantContent] });
      assistantContent.length = 0;
    }
    if (pendingResults.length > 0) {
      messages.push({ role: "tool", content: [...pendingResults] });
      pendingResults.length = 0;
    }
  };

  for (const step of turn.steps) {
    // Reasoning is not replayed: Cursor re-derives it, and a provider-signed
    // reasoning block from an earlier turn is not portable across requests.
    if (step.kind === "thinking") continue;
    if (step.kind === "assistantText") {
      if (!step.text) continue;
      // A new assistant text block after tool results starts a new message pair.
      if (pendingResults.length > 0) flushAssistant();
      assistantContent.push({ type: "text", text: step.text });
      continue;
    }
    if (!isToolCallStep(step)) continue;
    const toolName = toolNames.advertised(step.toolName);
    assistantContent.push({
      type: "tool-call",
      toolCallId: step.toolCallId,
      toolName,
      args: step.arguments,
    });
    if (step.result) {
      const imageSuffix = step.result.images?.length
        ? `\n\n[${step.result.images.length} image(s) in this earlier tool result are not replayed.]`
        : "";
      pendingResults.push({
        type: "tool-result",
        toolCallId: step.toolCallId,
        toolName,
        result: truncateReplayedResult(`${step.result.content}${imageSuffix}`),
        ...(step.result.isError ? { isError: true } : {}),
      });
    }
  }
  flushAssistant();

  return messages;
}

/**
 * Full prompt history for a request built without an upstream checkpoint:
 * Pi's system prompt followed by every completed turn.
 */
export function buildRootPromptMessages(
  systemPrompt: string,
  turns: ParsedTurn[],
  registeredToolNames: readonly string[] = [],
): RootPromptMessage[] {
  const messages: RootPromptMessage[] = [];
  if (systemPrompt.trim()) messages.push(systemPromptRootMessage(systemPrompt));
  for (const turn of turns) messages.push(...turnRootMessages(turn, registeredToolNames));
  return messages;
}

export function encodeRootPromptMessage(message: RootPromptMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

/** Env escape hatch: `PI_CURSOR_PROMPT_HISTORY=0` restores the pre-fix behavior. */
export function isPromptHistoryEnabled(envValue = process.env.PI_CURSOR_PROMPT_HISTORY): boolean {
  const raw = envValue?.trim().toLowerCase();
  if (!raw) return true;
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

/** Identity of the system prompt currently published to a Cursor conversation. */
export function hashSystemPrompt(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 32);
}
