import { describe, expect, it } from "bun:test";
import type { CursorParameterizedModel } from "../src/client/cursor-wire.js";
import { augmentCursorModels } from "../src/models/parameterized.js";
import { processModels } from "../src/models/processing.js";
import type { CursorModel } from "../src/stream/model-discovery.js";

function raw(id: string, name: string, contextWindow = 200_000): CursorModel {
  return { id, name, reasoning: false, contextWindow, maxTokens: 64_000 };
}

const grok46: CursorParameterizedModel = {
  name: "grok-4.6",
  clientDisplayName: "Cursor Grok 4.6",
  supportsMaxMode: true,
  supportsNonMaxMode: true,
  contextTokenLimit: 256_000,
  contextTokenLimitForMaxMode: 256_000,
  variants: [
    {
      parameters: [
        { id: "effort", value: "low" },
        { id: "fast", value: "false" },
      ],
      isMaxMode: false,
    },
    {
      parameters: [
        { id: "effort", value: "medium" },
        { id: "fast", value: "false" },
      ],
      isMaxMode: false,
    },
    {
      parameters: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
      isMaxMode: false,
    },
  ],
};

describe("augmentCursorModels context overlay", () => {
  it("copies parameterized contextTokenLimit onto cursor-prefixed GetUsableModels rows", () => {
    const augmented = augmentCursorModels(
      [
        raw("cursor-grok-4.6-high", "Cursor Grok 4.6"),
        raw("cursor-grok-4.6-medium", "Cursor Grok 4.6 Medium"),
        raw("cursor-grok-4.6-low", "Cursor Grok 4.6 Low"),
      ],
      [grok46],
    );

    const prefixed = augmented.filter((model) => model.id.startsWith("cursor-grok-4.6"));
    expect(prefixed).toHaveLength(3);
    for (const model of prefixed) expect(model.contextWindow).toBe(256_000);

    const collapsed = processModels(augmented).find((model) => model.id === "cursor-grok-4.6");
    expect(collapsed?.contextWindow).toBe(256_000);
  });

  it("does not invent cursor-prefixed rows when GetUsableModels omitted them", () => {
    const augmented = augmentCursorModels([], [grok46]);
    expect(augmented.some((model) => model.id.startsWith("cursor-"))).toBe(false);
    expect(augmented.some((model) => model.id.startsWith("grok-4.6"))).toBe(true);
  });
});
