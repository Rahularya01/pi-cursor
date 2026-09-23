import { describe, expect, it } from "vitest";
import type { CursorParameterizedModel } from "../src/client/cursor-wire.js";
import { augmentCursorModels } from "../src/models/parameterized.js";
import { buildRawModelLookup, processModels } from "../src/models/processing.js";
import { applyNativeCursorRouting } from "../src/stream/pi-adapter.js";
import type { ChatCompletionRequest } from "../src/stream/types.js";
import type { CursorModel } from "../src/stream/model-discovery.js";

function raw(id: string, name: string): CursorModel {
  return { id, name, reasoning: false, contextWindow: 256_000, maxTokens: 64_000 };
}

function param(
  id: string,
  requestedModelId: string,
  effort: string,
  fast: boolean,
  requestedMaxMode = false,
): CursorModel {
  return {
    id,
    name: `Cursor Grok 4.7 ${effort}`,
    reasoning: false,
    contextWindow: 256_000,
    maxTokens: 64_000,
    requestedModelId,
    parameters: [
      { id: "effort", value: effort },
      { id: "fast", value: String(fast) },
    ],
    requestedMaxMode,
  };
}

// Mirrors the live AvailableModels discovery payload for grok-4.7 (issue #38).
const grok47Metadata: CursorParameterizedModel = {
  name: "grok-4.7",
  clientDisplayName: "Cursor Grok 4.7",
  supportsImages: true,
  supportsMaxMode: true,
  supportsNonMaxMode: true,
  contextTokenLimit: 256_000,
  contextTokenLimitForMaxMode: 256_000,
  variants: ["low", "medium", "high", "xhigh"].flatMap((effort) =>
    [false, true].map((fast) => ({
      parameters: [
        { id: "effort", value: effort },
        { id: "fast", value: String(fast) },
      ],
      isMaxMode: false as const,
    })),
  ),
};

function grok47Lookup() {
  const rawRows: CursorModel[] = [
    raw("cursor-grok-4.7-low", "Cursor Grok 4.7 Low"),
    raw("cursor-grok-4.7-medium", "Cursor Grok 4.7 Medium"),
    raw("cursor-grok-4.7-high", "Cursor Grok 4.7"),
    raw("cursor-grok-4.7-xhigh", "Cursor Grok 4.7 Extra High"),
    raw("cursor-grok-4.7-low-fast", "Cursor Grok 4.7 Low Fast"),
    raw("cursor-grok-4.7-medium-fast", "Cursor Grok 4.7 Medium Fast"),
    raw("cursor-grok-4.7-high-fast", "Cursor Grok 4.7 Fast"),
    raw("cursor-grok-4.7-xhigh-fast", "Cursor Grok 4.7 Extra High Fast"),
    // Control family: must keep the legacy base-ID-plus-parameters routing.
    param("grok-4.5-low", "grok-4.5", "low", false),
    param("grok-4.5-medium", "grok-4.5", "medium", false),
    param("grok-4.5-high", "grok-4.5", "high", false),
  ];
  return buildRawModelLookup(processModels(augmentCursorModels(rawRows, [grok47Metadata])));
}

describe("grok-4.7 sibling wire routing (issue #38)", () => {
  it("routes bare grok-4.7 efforts to sibling IDs with no parameters", () => {
    const lookup = grok47Lookup();
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      const routing = lookup.get("grok-4.7")?.[effort];
      expect(routing?.modelId).toBe(`grok-4.7-${effort}`);
      expect(routing?.parameters ?? []).toEqual([]);
    }
  });

  it("routes grok-4.7-fast efforts to -fast sibling IDs", () => {
    const lookup = grok47Lookup();
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      const routing = lookup.get("grok-4.7-fast")?.[effort];
      expect(routing?.modelId).toBe(`grok-4.7-${effort}-fast`);
      expect(routing?.parameters ?? []).toEqual([]);
    }
  });

  it("routes grok-4.7-max and max-fast efforts preserving max mode", () => {
    const lookup = grok47Lookup();
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      const routing = lookup.get("grok-4.7-max")?.[effort];
      expect(routing?.modelId).toBe(`grok-4.7-${effort}`);
      expect(routing?.parameters ?? []).toEqual([]);
      expect(routing?.requestedMaxMode).toBe(true);
      const fastRouting = lookup.get("grok-4.7-max-fast")?.[effort];
      expect(fastRouting?.modelId).toBe(`grok-4.7-${effort}-fast`);
      expect(fastRouting?.parameters ?? []).toEqual([]);
      expect(fastRouting?.requestedMaxMode).toBe(true);
    }
  });

  it("routes cursor-prefixed grok-4.7 twins to working bare sibling IDs", () => {
    const lookup = grok47Lookup();
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      expect(lookup.get("cursor-grok-4.7")?.[effort]?.modelId).toBe(`grok-4.7-${effort}`);
      expect(lookup.get("cursor-grok-4.7-fast")?.[effort]?.modelId).toBe(`grok-4.7-${effort}-fast`);
      const maxRouting = lookup.get("cursor-grok-4.7-max")?.[effort];
      expect(maxRouting?.modelId).toBe(`grok-4.7-${effort}`);
      expect(maxRouting?.parameters ?? []).toEqual([]);
      expect(maxRouting?.requestedMaxMode).toBe(true);
      const maxFastRouting = lookup.get("cursor-grok-4.7-max-fast")?.[effort];
      expect(maxFastRouting?.modelId).toBe(`grok-4.7-${effort}-fast`);
      expect(maxFastRouting?.parameters ?? []).toEqual([]);
      expect(maxFastRouting?.requestedMaxMode).toBe(true);
    }
  });

  it("leaves other families (grok-4.5) on base-ID-plus-parameters routing", () => {
    const lookup = grok47Lookup();
    const routing = lookup.get("grok-4.5")?.high;
    expect(routing?.modelId).toBe("grok-4.5");
    expect(routing?.parameters).toEqual([
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ]);
  });

  it("applies sibling routing to the request body without parameters", () => {
    const lookup = grok47Lookup();
    const body: ChatCompletionRequest = {
      model: "grok-4.7",
      messages: [],
      reasoning_effort: "high",
    };
    applyNativeCursorRouting(body, lookup);
    expect(body.cursor_model_id).toBe("grok-4.7-high");
    expect(body.cursor_model_parameters).toBeUndefined();
  });
});
