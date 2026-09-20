import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";

import { applyCursorUsage, createCursorAssistantMessage } from "../src/stream/pi-adapter.js";
import type { StreamState } from "../src/stream/types.js";

const model = {
  id: "cursor-claude-4.6-sonnet",
  api: "cursor-native",
  provider: "cursor",
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as Model<Api>;

function state(overrides: Partial<StreamState>): StreamState {
  return {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 20,
    totalTokens: 0,
    turnEnded: true,
    ...overrides,
  };
}

describe("applyCursorUsage cache accounting", () => {
  it("reports a first turn (no prior context) as plain input, not a cache write", () => {
    const output = createCursorAssistantMessage(model);
    applyCursorUsage(output, model, state({ contextTokens: 1000 }));
    expect(output.usage).toMatchObject({ input: 1000, cacheRead: 0, cacheWrite: 0 });
  });

  it("attributes the overlap with the previous turn's context to cache read, and the rest to cache write", () => {
    const output = createCursorAssistantMessage(model);
    applyCursorUsage(output, model, state({ contextTokens: 1200, previousContextTokens: 1000 }));
    expect(output.usage).toMatchObject({ input: 0, cacheRead: 1000, cacheWrite: 200 });
    expect(output.usage?.cost.cacheRead).toBeCloseTo((1000 * 0.3) / 1_000_000);
    expect(output.usage?.cost.cacheWrite).toBeCloseTo((200 * 3.75) / 1_000_000);
  });

  it("never reports a false full cache miss when this turn's context shrank (e.g. after compaction)", () => {
    const output = createCursorAssistantMessage(model);
    applyCursorUsage(output, model, state({ contextTokens: 400, previousContextTokens: 1000 }));
    expect(output.usage).toMatchObject({ cacheRead: 400, cacheWrite: 0 });
  });
});
