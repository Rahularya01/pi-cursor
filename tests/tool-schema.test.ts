import { fromBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { afterEach, describe, expect, it } from "vitest";

import { buildMcpToolDefinitions } from "../src/stream/tool-schema.js";
import type { OpenAIToolDef } from "../src/stream/types.js";

const previousSlimTools = process.env.PI_CURSOR_SLIM_TOOLS;

afterEach(() => {
  if (previousSlimTools === undefined) delete process.env.PI_CURSOR_SLIM_TOOLS;
  else process.env.PI_CURSOR_SLIM_TOOLS = previousSlimTools;
});

function decodeSchema(tool: ReturnType<typeof buildMcpToolDefinitions>[number]): any {
  return toJson(ValueSchema, fromBinary(ValueSchema, tool.inputSchema));
}

function descriptionPropertyTool(): OpenAIToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: "delegate",
        description: "Delegate a task.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Task prompt." },
            description: { type: "string", description: "Short task label." },
            options: {
              type: "object",
              properties: {
                description: { type: "string", description: "Option label." },
                value: { type: "string", description: "Option value." },
              },
              required: ["description", "value"],
            },
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: { type: "string", description: "Entry label." },
                  value: { type: "string", description: "Entry value." },
                },
                required: ["description", "value"],
              },
            },
          },
          required: ["prompt", "description", "options", "entries"],
        },
      },
    },
  ];
}

describe("Cursor tool schema encoding", () => {
  it.each(["0", "1"])("preserves properties named description with slim mode %s", (slimMode) => {
    process.env.PI_CURSOR_SLIM_TOOLS = slimMode;
    const [tool] = buildMcpToolDefinitions(descriptionPropertyTool());
    const schema = decodeSchema(tool!);

    expect(schema.properties.description).toEqual(
      slimMode === "1" ? { type: "string" } : { type: "string", description: "Short task label." },
    );
    expect(schema.properties.options.properties.description).toBeDefined();
    expect(schema.properties.entries.items.properties.description).toBeDefined();
    expect(schema.required).toContain("description");
    expect(schema.properties.options.required).toContain("description");
    expect(schema.properties.entries.items.required).toContain("description");
  });

  it("distinguishes schema annotations from user-defined and literal keys", () => {
    process.env.PI_CURSOR_SLIM_TOOLS = "1";
    const [tool] = buildMcpToolDefinitions([
      {
        type: "function",
        function: {
          name: "schema_keywords",
          description: "Check schema keyword contexts.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", title: "Parameter prose" },
              default: { type: "string", default: "fallback" },
              literal: {
                type: "object",
                enum: [{ description: "literal description", title: "literal title" }],
              },
            },
            required: ["title", "default", "literal"],
            $defs: {
              description: { type: "string", description: "Definition prose" },
            },
          },
        },
      },
    ]);
    const schema = decodeSchema(tool!);

    expect(schema.properties.title).toEqual({ type: "string" });
    expect(schema.properties.default).toEqual({ type: "string" });
    expect(schema.$defs.description).toEqual({ type: "string" });
    expect(schema.properties.literal.enum).toEqual([
      { description: "literal description", title: "literal title" },
    ]);
    expect(schema.required).toEqual(["title", "default", "literal"]);
  });
});
