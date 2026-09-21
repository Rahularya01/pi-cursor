import { describe, expect, it } from "vitest";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { contextToCursorChatCompletionRequest } from "../src/stream/pi-adapter.js";
import {
  resolveContextSystemPrompt,
  resolveContextTools,
  transcriptSystemPrompt,
  transcriptTools,
} from "../src/stream/transcript-compat.js";

const model = { id: "composer-2.5", api: "cursor-native", provider: "cursor" } as Model<Api>;
const config = {} as never;

function tool(name: string, description = `${name} tool`) {
  return { name, description, parameters: { type: "object", properties: {} } } as never;
}

function system(fields: Record<string, unknown>) {
  return { role: "system", timestamp: 0, ...fields } as never;
}

const user = { role: "user", content: [{ type: "text", text: "run the thing" }] } as never;

/** Pi <= 0.85: prompt and tools arrive as top-level context fields. */
function legacyContext(): Context {
  return {
    systemPrompt: "LEGACY PROMPT",
    tools: [tool("bash")],
    messages: [user],
  } as unknown as Context;
}

/** Pi >= 0.86: `normalizeContext()` folded both into a leading system message. */
function transcriptContext(): Context {
  return {
    messages: [
      system({ content: "TRANSCRIPT PROMPT", toolsAdded: [tool("bash"), tool("read")] }),
      user,
    ],
  } as unknown as Context;
}

describe("transcriptSystemPrompt", () => {
  it("returns an empty prompt for a transcript with no system messages", () => {
    expect(transcriptSystemPrompt([user])).toBe("");
  });

  it("renders the leading message body followed by its sections", () => {
    const prompt = transcriptSystemPrompt([
      system({ content: "base", sections: { tools: "<tools>bash</tools>", rules: "<rules/>" } }),
    ]);
    expect(prompt).toBe("base\n\n<tools>bash</tools>\n\n<rules/>");
  });

  it("reads a content block array, not just a bare string", () => {
    const prompt = transcriptSystemPrompt([
      system({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "…" },
          { type: "text", text: "second" },
        ],
      }),
    ]);
    expect(prompt).toBe("first\nsecond");
  });

  it("appends later instructions and patches sections by name", () => {
    const prompt = transcriptSystemPrompt([
      system({ content: "base", sections: { rules: "old rules", extra: "keep me" } }),
      user,
      system({ content: "and also this", sections: { rules: "new rules" } }),
    ]);
    expect(prompt).toBe("base\n\nand also this\n\nnew rules\n\nkeep me");
  });

  it("drops a section a later message removed with null", () => {
    const prompt = transcriptSystemPrompt([
      system({ content: "base", sections: { rules: "old rules" } }),
      system({ sections: { rules: null } }),
    ]);
    expect(prompt).toBe("base");
  });
});

describe("transcriptTools", () => {
  it("resolves additions and removals in transcript order", () => {
    const tools = transcriptTools([
      system({ toolsAdded: [tool("bash"), tool("read")] }),
      user,
      system({ toolsAdded: [tool("write")], toolsRemoved: [{ name: "read" }] }),
    ]);
    expect(tools.map((t) => t.name)).toEqual(["bash", "write"]);
  });

  it("keeps the latest definition when a tool is redeclared", () => {
    const tools = transcriptTools([
      system({ toolsAdded: [tool("bash", "old")] }),
      system({ toolsAdded: [tool("bash", "new")] }),
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].description).toBe("new");
  });
});

describe("resolveContext* across host versions", () => {
  it("uses the legacy fields when the host still sends them", () => {
    const context = legacyContext();
    expect(resolveContextSystemPrompt(context)).toBe("LEGACY PROMPT");
    expect(resolveContextTools(context).map((t) => t.name)).toEqual(["bash"]);
  });

  it("falls back to the transcript when the legacy fields are gone", () => {
    const context = transcriptContext();
    expect(resolveContextSystemPrompt(context)).toBe("TRANSCRIPT PROMPT");
    expect(resolveContextTools(context).map((t) => t.name)).toEqual(["bash", "read"]);
  });

  it("does not mutate the caller's tool array", () => {
    const context = legacyContext();
    resolveContextTools(context).push(tool("injected"));
    expect(context.tools).toHaveLength(1);
  });
});

describe("contextToCursorChatCompletionRequest on a 0.86 transcript", () => {
  it("sends the transcript prompt and tools instead of an empty request", () => {
    const body = contextToCursorChatCompletionRequest(
      model,
      transcriptContext(),
      undefined,
      config,
    );
    expect(body.messages[0]).toEqual({ role: "system", content: "TRANSCRIPT PROMPT" });
    expect(body.tools?.map((t) => t.function.name)).toEqual(["bash", "read"]);
  });

  it("keeps system messages out of the replayed message list", () => {
    const body = contextToCursorChatCompletionRequest(
      model,
      {
        messages: [
          system({ content: "PROMPT", toolsAdded: [tool("bash")] }),
          user,
          system({ content: "mid-conversation update" }),
        ],
      } as unknown as Context,
      undefined,
      config,
    );
    expect(body.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(body.messages[0].content).toBe("PROMPT\n\nmid-conversation update");
    expect(body.messages.at(-1)!.role).toBe("user");
  });

  it("leaves a trailing aborted turn unannotated even behind a system message", () => {
    const body = contextToCursorChatCompletionRequest(
      model,
      {
        messages: [
          system({ content: "PROMPT" }),
          user,
          { role: "assistant", content: [], stopReason: "aborted" },
          system({ toolsAdded: [tool("bash")] }),
        ],
      } as unknown as Context,
      undefined,
      config,
    );
    const assistantMsg = body.messages.find((m) => m.role === "assistant")!;
    expect(assistantMsg.interrupted_notice).toBeUndefined();
  });
});
