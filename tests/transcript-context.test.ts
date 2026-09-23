import { describe, expect, it } from "bun:test";
import type { Api, Context, Model, Tool as PiTool } from "@earendil-works/pi-ai";
import {
  contextToCursorChatCompletionRequest,
  resolveTranscriptInputs,
} from "../src/stream/pi-adapter.js";

const model = { id: "cursor-grok-4.6", api: "cursor-native", provider: "cursor" } as Model<Api>;
const config = {} as never;

function tool(name: string, description = `${name} tool`): PiTool {
  return {
    name,
    description,
    parameters: { type: "object", properties: {} },
  } as unknown as PiTool;
}

function systemMessage(fields: Record<string, unknown>) {
  return { role: "system", timestamp: 0, ...fields } as never;
}

function ctx(fields: Record<string, unknown>): Context {
  return { messages: [], ...fields } as unknown as Context;
}

const userTurn = { role: "user", content: [{ type: "text", text: "hi" }] } as never;

describe("resolveTranscriptInputs", () => {
  it("reads the legacy Context fields when no system message is present", () => {
    const resolved = resolveTranscriptInputs(
      ctx({ systemPrompt: "SYS", tools: [tool("bash")], messages: [userTurn] }),
    );
    expect(resolved.systemPrompt).toBe("SYS");
    expect(resolved.tools.map((t) => t.name)).toEqual(["bash"]);
  });

  it("falls back to empty values when neither shape carries anything", () => {
    const resolved = resolveTranscriptInputs(ctx({ messages: [userTurn] }));
    expect(resolved.systemPrompt).toBe("");
    expect(resolved.tools).toEqual([]);
  });

  it("replays tool declarations from transcript system messages", () => {
    const resolved = resolveTranscriptInputs(
      ctx({
        messages: [
          systemMessage({ content: "SYS", toolsAdded: [tool("bash"), tool("read")] }),
          userTurn,
          systemMessage({ toolsAdded: [tool("write")], toolsRemoved: [{ name: "read" }] }),
        ],
      }),
    );
    expect(resolved.tools.map((t) => t.name)).toEqual(["bash", "write"]);
  });

  it("applies toolsRemoved before toolsAdded so a redefinition wins", () => {
    const resolved = resolveTranscriptInputs(
      ctx({
        messages: [
          systemMessage({ toolsAdded: [tool("bash", "old")] }),
          systemMessage({
            toolsRemoved: [{ name: "bash" }],
            toolsAdded: [tool("bash", "new")],
          }),
        ],
      }),
    );
    expect(resolved.tools).toHaveLength(1);
    expect(resolved.tools[0]!.description).toBe("new");
  });

  it("joins system message content and patches named sections", () => {
    const resolved = resolveTranscriptInputs(
      ctx({
        messages: [
          systemMessage({
            content: "base rules",
            sections: { env: "cwd=/a", stale: "drop me" },
          }),
          userTurn,
          systemMessage({
            content: [{ type: "text", text: "more rules" }],
            sections: { env: "cwd=/b", stale: null },
          }),
        ],
      }),
    );
    expect(resolved.systemPrompt).toBe("base rules\n\nmore rules\n\ncwd=/b");
  });

  it("prefers the transcript when a context carries both shapes", () => {
    const resolved = resolveTranscriptInputs(
      ctx({
        systemPrompt: "LEGACY",
        tools: [tool("legacy")],
        messages: [systemMessage({ content: "TRANSCRIPT", toolsAdded: [tool("bash")] })],
      }),
    );
    expect(resolved.systemPrompt).toBe("TRANSCRIPT");
    expect(resolved.tools.map((t) => t.name)).toEqual(["bash"]);
  });
});

describe("contextToCursorChatCompletionRequest with a normalized transcript", () => {
  it("sends the transcript's tools and system prompt to Cursor", () => {
    const body = contextToCursorChatCompletionRequest(
      model,
      ctx({
        messages: [
          systemMessage({ content: "SYS", toolsAdded: [tool("bash"), tool("write")] }),
          userTurn,
        ],
      }),
      undefined,
      config,
    );
    expect(body.tools?.map((t) => t.function.name)).toEqual(["bash", "write"]);
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(body.messages[1]!.role).toBe("user");
  });

  it("does not treat a live aborted turn as history when a system delta trails it", () => {
    const body = contextToCursorChatCompletionRequest(
      model,
      ctx({
        messages: [
          systemMessage({ content: "SYS", toolsAdded: [tool("bash")] }),
          userTurn,
          { role: "assistant", content: [], stopReason: "aborted" } as never,
          systemMessage({ toolsAdded: [tool("write")] }),
        ],
      }),
      undefined,
      config,
    );
    expect(body.messages.at(-1)!.interrupted_notice).toBeUndefined();
  });

  it("still works on the legacy context shape", () => {
    const body = contextToCursorChatCompletionRequest(
      model,
      ctx({ systemPrompt: "SYS", tools: [tool("bash")], messages: [userTurn] }),
      undefined,
      config,
    );
    expect(body.tools?.map((t) => t.function.name)).toEqual(["bash"]);
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
  });
});
