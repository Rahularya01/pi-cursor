import { describe, expect, it } from "vitest";
import { resolveModelId, resolveRequestedModelId } from "../src/stream/model-routing.js";

describe("resolveModelId", () => {
  it("inserts effort before -fast/-thinking", () => {
    expect(resolveModelId("gpt-5.5", "high")).toBe("gpt-5.5-high");
    expect(resolveModelId("gpt-5.5-fast", "medium")).toBe("gpt-5.5-medium-fast");
    expect(resolveModelId("claude-4.6-opus-thinking", "max")).toBe("claude-4.6-opus-max-thinking");
    expect(resolveModelId("composer-2")).toBe("composer-2");
  });
});

describe("resolveRequestedModelId", () => {
  it("prefers explicit cursor model id for string models", () => {
    expect(resolveRequestedModelId("composer-2", "high", "composer-2-high")).toBe(
      "composer-2-high",
    );
  });

  it("resolves object models from effort routing map", () => {
    const routing = new Map([
      [
        "composer-2",
        {
          high: { modelId: "composer-2-high", requestedMaxMode: false },
          medium: { modelId: "composer-2", requestedMaxMode: false },
        },
      ],
    ]);
    const resolved = resolveRequestedModelId({ id: "composer-2" }, "high", routing);
    expect(resolved.modelId).toBe("composer-2-high");
    expect(resolved.maxMode).toBe(false);
  });
});
