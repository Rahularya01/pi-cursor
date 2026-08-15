import { describe, expect, it } from "vitest";
import {
  MAX_MCP_TOOL_RESULT_BYTES,
  MAX_MCP_TOOL_TEXT_BYTES,
  buildMcpToolDefinitions,
  isSlimToolsEnabled,
  isTrivialConversationalTurn,
  normalizeToolResultForTransport,
  slimOpenAIToolsForCursor,
  summarizeRequestSize,
} from "../src/stream/request-build.js";
import type { OpenAIToolDef } from "../src/stream/types.js";

function fatTools(count: number): OpenAIToolDef[] {
  return Array.from({ length: count }, (_, i) => ({
    type: "function" as const,
    function: {
      name: `tool_${i}`,
      description: ("Verbose tool description that burns tokens. " + i + " ").repeat(40),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "A very long parameter description. ".repeat(30),
            enum: Array.from({ length: 80 }, (_, j) => `value_${j}`),
          },
        },
        required: ["path"],
      },
    },
  }));
}

describe("tool result transport bounds", () => {
  it("truncates huge UTF-8 text without splitting a code point", () => {
    const normalized = normalizeToolResultForTransport({
      content: "🙂".repeat(MAX_MCP_TOOL_TEXT_BYTES),
      isError: false,
    });

    expect(Buffer.byteLength(normalized.content, "utf8")).toBeLessThanOrEqual(
      MAX_MCP_TOOL_TEXT_BYTES,
    );
    expect(normalized.content).toContain("pi-cursor truncated this tool result");
    expect(normalized.content).not.toContain("�");
  });

  it("omits images that would make one tool result unsafe", () => {
    const normalized = normalizeToolResultForTransport({
      content: "screenshot",
      isError: false,
      images: [
        { data: new Uint8Array(MAX_MCP_TOOL_RESULT_BYTES), mimeType: "image/png" },
        { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
      ],
    });

    expect(normalized.images).toHaveLength(1);
    expect(normalized.images?.[0]?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(normalized.content).toContain("omitted 1 oversized tool image");
  });
});

describe("trivial conversational turns", () => {
  it.each([
    "hi",
    "Hello!",
    "thank you",
    "PING",
    "sounds good.",
    "what can you do for me?",
    "who are you?",
  ])("identifies %j as tool-free", (text) => expect(isTrivialConversationalTurn(text)).toBe(true));

  it.each([
    "hi, inspect src",
    "thanks, now run tests",
    "test the build",
    "how are you doing this?",
  ])("keeps tools for actionable text %j", (text) =>
    expect(isTrivialConversationalTurn(text)).toBe(false),
  );
});

describe("slim tools for Cursor", () => {
  it("defaults slim mode on", () => {
    expect(isSlimToolsEnabled(undefined)).toBe(true);
    expect(isSlimToolsEnabled("0")).toBe(false);
    expect(isSlimToolsEnabled("false")).toBe(false);
  });

  it("removes schema prose but preserves the executable contract", () => {
    const slim = slimOpenAIToolsForCursor(fatTools(1));
    const fn = slim[0]!.function;
    expect((fn.description || "").length).toBeLessThanOrEqual(120);
    const parameters = fn.parameters as any;
    const path = parameters.properties.path;
    expect(path.description).toBeUndefined();
    expect(path.type).toBe("string");
    expect(path.enum).toHaveLength(80);
    expect(parameters.required).toEqual(["path"]);
  });

  it("materially shrinks MCP schema payload vs raw tools", () => {
    const raw = fatTools(20);
    const prev = process.env.PI_CURSOR_SLIM_TOOLS;
    try {
      process.env.PI_CURSOR_SLIM_TOOLS = "0";
      const rawMcp = buildMcpToolDefinitions(raw);
      let rawBytes = 0;
      for (const t of rawMcp) rawBytes += t.inputSchema?.byteLength ?? 0;

      process.env.PI_CURSOR_SLIM_TOOLS = "1";
      const slimMcp = buildMcpToolDefinitions(raw);
      let slimBytes = 0;
      for (const t of slimMcp) slimBytes += t.inputSchema?.byteLength ?? 0;

      expect(slimBytes).toBeLessThan(rawBytes * 0.5);
    } finally {
      if (prev === undefined) delete process.env.PI_CURSOR_SLIM_TOOLS;
      else process.env.PI_CURSOR_SLIM_TOOLS = prev;
    }
  });
});

describe("request size summary", () => {
  it("reports the dominant contributors", () => {
    const tools = fatTools(5);
    const mcpTools = buildMcpToolDefinitions(tools);
    const summary = summarizeRequestSize({
      systemPrompt: "x".repeat(4000),
      userText: "hi",
      tools,
      mcpTools,
      requestBytes: new Uint8Array(1200),
      blobStore: new Map([["a", new Uint8Array(500)]]),
      turnCount: 2,
    });
    expect(summary.systemChars).toBe(4000);
    expect(summary.userChars).toBe(2);
    expect(summary.toolCount).toBe(5);
    expect(summary.requestBytes).toBe(1200);
    expect(summary.blobBytes).toBe(500);
    expect(summary.wireBytes).toBe(1700);
    expect(summary.approxInputTokens).toBe(425);
  });
});
