import { describe, expect, it } from "vitest";
import { fromBinary } from "@bufbuild/protobuf";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  contextToCursorChatCompletionRequest,
  interruptedAssistantNotice,
  MAX_INTERRUPTED_NOTICE_ERROR_CHARS,
} from "../src/stream/pi-adapter.js";
import { parseMessages } from "../src/stream/message-parsing.js";
import { buildCursorRequest } from "../src/stream/request-build.js";
import {
  AgentClientMessageSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
} from "../src/proto/agent_pb.js";
import type { OpenAIMessage } from "../src/stream/types.js";

const model = { id: "cursor-grok-4.6", api: "cursor-native", provider: "cursor" } as Model<Api>;

function ctx(messages: Context["messages"]): Context {
  return { systemPrompt: "SYS", messages, tools: [] } as unknown as Context;
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}) {
  return { role: "assistant", content, stopReason: "stop", ...extra } as never;
}

describe("interruptedAssistantNotice", () => {
  it("stays silent for turns that completed normally", () => {
    expect(interruptedAssistantNotice({ stopReason: "stop" })).toBe("");
    expect(interruptedAssistantNotice({ stopReason: "toolUse" })).toBe("");
    expect(interruptedAssistantNotice({ stopReason: "deferred" })).toBe("");
    expect(interruptedAssistantNotice({})).toBe("");
  });

  it("describes each way a turn can fail to finish", () => {
    expect(interruptedAssistantNotice({ stopReason: "aborted" })).toContain("was interrupted");
    expect(interruptedAssistantNotice({ stopReason: "length" })).toContain("output limit");
    expect(interruptedAssistantNotice({ stopReason: "pending" })).toContain("never completed");
    for (const reason of ["aborted", "length", "pending", "error"] as const) {
      expect(interruptedAssistantNotice({ stopReason: reason })).toMatch(
        /^\[pi-cursor: .*nothing further was produced\.\]$/,
      );
    }
  });

  it("carries the error detail, collapsed onto one line", () => {
    const notice = interruptedAssistantNotice({
      stopReason: "error",
      errorMessage: "Cursor HTTP 500:\n  upstream failed",
    });
    expect(notice).toContain("(Cursor HTTP 500: upstream failed)");
    expect(notice).not.toContain("\n");
  });

  it("redacts credentials that ride along in the error text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-DEF_123";
    const notice = interruptedAssistantNotice({
      stopReason: "error",
      errorMessage: `auth failed for Bearer ${jwt}`,
    });
    expect(notice).not.toContain(jwt);
    expect(notice).toContain("[redacted-jwt]");
  });

  it("bounds a huge error so it cannot dominate the replayed history", () => {
    const notice = interruptedAssistantNotice({
      stopReason: "error",
      errorMessage: "x".repeat(5_000),
    });
    expect(notice.length).toBeLessThan(MAX_INTERRUPTED_NOTICE_ERROR_CHARS + 200);
    expect(notice).toContain("…");
  });

  it("omits an empty detail rather than emitting empty parentheses", () => {
    const notice = interruptedAssistantNotice({ stopReason: "error", errorMessage: "   " });
    expect(notice).not.toContain("()");
    expect(notice).toContain("ended with an error");
  });
});

describe("contextToCursorChatCompletionRequest", () => {
  const config = {} as never;

  it("annotates an aborted assistant turn that history has moved past", () => {
    const body = contextToCursorChatCompletionRequest(
      model,
      ctx([
        { role: "user", content: [{ type: "text", text: "what mcp should I install?" }] },
        assistant([], { stopReason: "error", errorMessage: "This operation was aborted" }),
        { role: "user", content: [{ type: "text", text: "continue please" }] },
      ] as never),
      undefined,
      config,
    );
    const assistantMsg = body.messages.find((m) => m.role === "assistant")!;
    expect(assistantMsg.interrupted_notice).toContain("ended with an error");
  });

  it("leaves a trailing aborted turn alone so the live user text is not stranded", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "do the thing" }] },
      assistant([], { stopReason: "aborted" }),
    ] as never;
    const body = contextToCursorChatCompletionRequest(model, ctx(messages), undefined, config);
    expect(body.messages.at(-1)!.interrupted_notice).toBeUndefined();

    // The regression this guard exists for: the turn must still parse as a
    // live user turn with no steps, not as completed history with no user text.
    const parsed = parseMessages(body.messages);
    expect(parsed.userText).toBe("do the thing");
    expect(parsed.turns).toHaveLength(0);
  });

  it("does not annotate turns that ended cleanly", () => {
    const body = contextToCursorChatCompletionRequest(
      model,
      ctx([
        { role: "user", content: [{ type: "text", text: "hello" }] },
        assistant([{ type: "text", text: "hi" }]),
        { role: "user", content: [{ type: "text", text: "again" }] },
      ] as never),
      undefined,
      config,
    );
    expect(body.messages.find((m) => m.role === "assistant")!.interrupted_notice).toBeUndefined();
  });

  it("replays prior thinking into the Cursor turn structure", () => {
    const body = contextToCursorChatCompletionRequest(
      model,
      ctx([
        { role: "user", content: [{ type: "text", text: "plan this" }] },
        assistant([
          { type: "thinking", thinking: "I should inspect src first" },
          { type: "text", text: "I'll start with src." },
        ]),
        { role: "user", content: [{ type: "text", text: "go" }] },
      ] as never),
      undefined,
      config,
    );
    const assistantMsg = body.messages.find((m) => m.role === "assistant")!;
    expect(assistantMsg.thinking).toContain("inspect src");
    const parsed = parseMessages(body.messages);
    expect(parsed.turns[0]!.steps.some((step) => step.kind === "thinking")).toBe(true);
  });
});

describe("parseMessages", () => {
  it("places the notice after the tool calls the turn managed to emit", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "search for it" },
      {
        role: "assistant",
        content: "on it",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } },
        ],
        interrupted_notice: "[pi-cursor: interrupted; nothing further was produced.]",
      },
      { role: "tool", tool_call_id: "c1", content: "Search cancelled (stale)." },
      { role: "user", content: "continue please" },
    ];
    const parsed = parseMessages(messages);
    expect(parsed.turns).toHaveLength(1);
    const steps = parsed.turns[0]!.steps;
    expect(steps.map((s) => s.kind)).toEqual(["assistantText", "toolCall", "assistantText"]);
    expect(steps.at(-1)).toMatchObject({ kind: "assistantText" });
  });

  it("merges the notice into the trailing text when there are no tool calls", () => {
    const parsed = parseMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "partial answ", interrupted_notice: "[pi-cursor: cut off.]" },
      { role: "user", content: "continue please" },
    ]);
    const steps = parsed.turns[0]!.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "assistantText" });
    expect((steps[0] as { text: string }).text).toBe("partial answ\n\n[pi-cursor: cut off.]");
  });

  it("becomes the whole step when the turn produced nothing at all", () => {
    const parsed = parseMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", interrupted_notice: "[pi-cursor: aborted.]" },
      { role: "user", content: "continue please" },
    ]);
    expect(parsed.turns[0]!.steps).toEqual([
      { kind: "assistantText", text: "[pi-cursor: aborted.]" },
    ]);
  });

  it("is a no-op when no notice is set", () => {
    const parsed = parseMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "user", content: "again" },
    ]);
    expect(parsed.turns[0]!.steps).toEqual([]);
  });
});

describe("end to end", () => {
  // Mirrors the real session that surfaced this: a turn aborted mid-web_search
  // replayed after a restart as a turn that simply trailed off.
  it("puts the abort on the wire in the replayed history", () => {
    const body = contextToCursorChatCompletionRequest(
      model,
      ctx([
        { role: "user", content: [{ type: "text", text: "what mcp should I install?" }] },
        assistant(
          [
            { type: "text", text: "I'll look at your setup" },
            { type: "toolCall", id: "c1", name: "web_search", arguments: {} },
          ],
          { stopReason: "error", errorMessage: "This operation was aborted" },
        ),
        { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "cancelled" }] },
        { role: "user", content: [{ type: "text", text: "continue please" }] },
      ] as never),
      undefined,
      {} as never,
    );

    const parsed = parseMessages(body.messages);
    const payload = buildCursorRequest(
      "cursor-grok-4.6",
      parsed.systemPrompt,
      parsed.userText,
      parsed.turns,
      "conv",
      null,
    );

    const run = fromBinary(AgentClientMessageSchema, payload.requestBytes).message
      .value as unknown as { conversationState: { turns: Uint8Array[] } };
    const turnBlob = payload.blobStore.get(
      Buffer.from(run.conversationState.turns[0]!).toString("hex"),
    )!;
    const turnStruct = fromBinary(ConversationTurnStructureSchema, turnBlob);
    const steps = (turnStruct.turn.value as unknown as { steps: Uint8Array[] }).steps;

    const texts = steps
      .map((ref) =>
        fromBinary(
          ConversationStepSchema,
          payload.blobStore.get(Buffer.from(ref).toString("hex"))!,
        ),
      )
      .filter((step) => step.message.case === "assistantMessage")
      .map((step) => (step.message.value as unknown as { text: string }).text);

    expect(texts.at(-1)).toContain("ended with an error before it finished");
    expect(texts.at(-1)).toContain("This operation was aborted");
  });
});
