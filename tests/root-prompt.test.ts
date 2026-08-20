import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  AgentClientMessageSchema,
  ConversationStateStructureSchema,
} from "../src/proto/agent_pb.js";
import { buildCursorRequest } from "../src/stream/request-build.js";
import { fingerprintCompletedTurns } from "../src/stream/recovery.js";
import {
  buildRootPromptMessages,
  cursorMcpToolName,
  isPromptHistoryEnabled,
  turnRootMessages,
  type RootPromptMessage,
} from "../src/stream/root-prompt.js";
import type { ParsedTurn } from "../src/stream/types.js";

function rootPromptMessages(payload: {
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
}): unknown[] {
  const message = fromBinary(AgentClientMessageSchema, payload.requestBytes);
  expect(message.message.case).toBe("runRequest");
  const runRequest = message.message.value as { conversationState?: unknown };
  const state = runRequest.conversationState as ReturnType<
    typeof fromBinary<typeof ConversationStateStructureSchema>
  >;
  return state.rootPromptMessagesJson.map((id) => {
    const blob = payload.blobStore.get(Buffer.from(id).toString("hex"));
    expect(blob, "every root prompt blob must be published").toBeDefined();
    return JSON.parse(new TextDecoder().decode(blob!)) as unknown;
  });
}

const historyTurn: ParsedTurn = {
  userText: "my favourite color is black",
  steps: [
    { kind: "thinking", text: "The user shared a preference." },
    { kind: "assistantText", text: "Got it — black." },
    {
      kind: "toolCall",
      toolCallId: "call_1",
      toolName: "read_file",
      arguments: { path: "notes.md" },
      result: { content: "nothing relevant", isError: false },
    },
  ],
};

describe("root prompt messages", () => {
  it("carries the system prompt on a user message, never a system one", () => {
    const messages = buildRootPromptMessages("PI SYSTEM PROMPT", []);
    expect(messages).toHaveLength(1);
    const [rules] = messages as [RootPromptMessage];
    // Cursor's server drops `system` entries and substitutes its own prompt.
    expect(rules.role).toBe("user");
    expect(JSON.stringify(rules)).toContain("<rules>");
    expect(JSON.stringify(rules)).toContain("PI SYSTEM PROMPT");
  });

  it("omits the rules message when there is no system prompt", () => {
    expect(buildRootPromptMessages("   ", [])).toHaveLength(0);
  });

  it("renders a turn as user / assistant / tool messages and skips reasoning", () => {
    const messages = turnRootMessages(historyTurn);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("my favourite color is black");
    expect(serialized).toContain("Got it — black.");
    expect(serialized).not.toContain("The user shared a preference.");
    expect(serialized).toContain("mcp_pi_read_file");
    expect(serialized).toContain("nothing relevant");
  });

  it("namespaces MCP tool names once", () => {
    expect(cursorMcpToolName("grep")).toBe("mcp_pi_grep");
    expect(cursorMcpToolName("mcp_pi_grep")).toBe("mcp_pi_grep");
  });

  it("notes unreplayed images instead of dropping the turn silently", () => {
    const messages = turnRootMessages({
      userText: "what is in this screenshot?",
      steps: [],
      userImages: [{ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
    });
    expect(JSON.stringify(messages)).toContain("image attachment(s)");
  });

  it("respects the PI_CURSOR_PROMPT_HISTORY escape hatch", () => {
    expect(isPromptHistoryEnabled(undefined)).toBe(true);
    expect(isPromptHistoryEnabled("0")).toBe(false);
    expect(isPromptHistoryEnabled("off")).toBe(false);
  });
});

describe("request build root prompt wiring", () => {
  it("publishes system prompt and completed turns when there is no checkpoint", () => {
    const payload = buildCursorRequest({
      modelId: "cursor-grok-4.6-low",
      systemPrompt: "PI SYSTEM PROMPT",
      userText: "what was my favourite color?",
      turns: [historyTurn],
      conversationId: "conv-1",
      checkpoint: null,
    });
    const messages = rootPromptMessages(payload);
    const roles = messages.map((m) => (m as { role: string }).role);
    // [0] is the legacy system blob the selected-context blob points at.
    expect(roles[0]).toBe("system");
    expect(roles.slice(1)).toEqual(["user", "user", "assistant", "tool"]);
    expect(JSON.stringify(messages)).toContain("my favourite color is black");
  });

  it("re-publishes the system prompt onto a checkpoint only when asked", () => {
    const checkpoint = toBinary(
      ConversationStateStructureSchema,
      create(ConversationStateStructureSchema, { clientName: "cli" }),
    );
    const pinned = buildCursorRequest({
      modelId: "cursor-grok-4.6-low",
      systemPrompt: "UPDATED PI PROMPT",
      userText: "next",
      turns: [historyTurn],
      conversationId: "conv-1",
      checkpoint,
    });
    // A checkpoint already holds the rendered history; nothing is republished.
    expect(rootPromptMessages(pinned)).toHaveLength(0);

    const refreshed = buildCursorRequest({
      modelId: "cursor-grok-4.6-low",
      systemPrompt: "UPDATED PI PROMPT",
      userText: "next",
      turns: [historyTurn],
      conversationId: "conv-1",
      checkpoint,
      refreshSystemPrompt: true,
    });
    const messages = rootPromptMessages(refreshed);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { role: string }).role).toBe("user");
    expect(JSON.stringify(messages)).toContain("UPDATED PI PROMPT");
  });
});

describe("history fingerprint", () => {
  it("ignores replayed reasoning so a checkpoint survives a reasoning turn", () => {
    const withoutThinking: ParsedTurn = {
      userText: historyTurn.userText,
      steps: historyTurn.steps.filter((step) => step.kind !== "thinking"),
    };
    expect(fingerprintCompletedTurns([historyTurn])).toBe(
      fingerprintCompletedTurns([withoutThinking]),
    );
  });

  it("still detects a rewritten user turn", () => {
    expect(fingerprintCompletedTurns([historyTurn])).not.toBe(
      fingerprintCompletedTurns([{ ...historyTurn, userText: "different" }]),
    );
  });
});
