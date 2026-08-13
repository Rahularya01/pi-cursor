import { describe, expect, it } from "vitest";
import {
  CURSOR_FALLBACK_CONTEXT_WINDOW,
  lookupCursorContextWindow,
} from "../src/models/context-windows.js";
import { inferCursorContextWindow } from "../src/stream/model-discovery.js";

describe("lookupCursorContextWindow", () => {
  it("returns the documented default window per family", () => {
    expect(lookupCursorContextWindow("cursor-grok-4.6-high")).toBe(256_000);
    expect(lookupCursorContextWindow("gemini-3.6-flash-low")).toBe(200_000);
    expect(lookupCursorContextWindow("gpt-5.6-sol-medium")).toBe(272_000);
    expect(lookupCursorContextWindow("claude-opus-5-thinking-high")).toBe(300_000);
  });

  it("returns the documented max-mode window only where Cursor unlocks one", () => {
    expect(lookupCursorContextWindow("gemini-3.6-flash-low", true)).toBe(1_000_000);
    expect(lookupCursorContextWindow("claude-sonnet-5-high", true)).toBe(1_000_000);
    expect(lookupCursorContextWindow("kimi-k3-max", true)).toBe(1_000_000);
    // Grok and Composer have no documented Max Mode window: stay at the default.
    expect(lookupCursorContextWindow("cursor-grok-4.6-high", true)).toBe(256_000);
    expect(lookupCursorContextWindow("composer-2.5-fast", true)).toBe(200_000);
  });

  it("does not match unknown families", () => {
    expect(lookupCursorContextWindow("some-future-model-high")).toBeUndefined();
  });
});

describe("inferCursorContextWindow", () => {
  it("prefers the table over the display-name heuristic", () => {
    // Cursor names these rows "... 1M" but caps the default window lower.
    expect(inferCursorContextWindow("gpt-5.6-sol-medium", "GPT-5.6 Sol 1M")).toBe(272_000);
    expect(inferCursorContextWindow("claude-sonnet-5-high", "Sonnet 5 1M")).toBe(200_000);
    expect(inferCursorContextWindow("claude-fable-5-high", "Fable 5 1M (NO ZDR)")).toBe(300_000);
  });

  it("fixes families that used to fall through to the 200k fallback", () => {
    expect(inferCursorContextWindow("cursor-grok-4.5-medium", "Cursor Grok 4.5 Medium")).toBe(
      256_000,
    );
    expect(inferCursorContextWindow("gemini-3.1-pro", "Gemini 3.1 Pro", true)).toBe(1_000_000);
    expect(inferCursorContextWindow("kimi-k3-high", "Kimi K3 High", true)).toBe(1_000_000);
  });

  it("keeps the display-name heuristic for untabled models", () => {
    expect(inferCursorContextWindow("claude-4.6-opus-high", "Opus 4.6 1M")).toBe(1_000_000);
    expect(inferCursorContextWindow("gpt-5.5-high", "GPT-5.5 272K High")).toBe(272_000);
  });

  it("falls back to the documented Cursor default for unknown models", () => {
    expect(inferCursorContextWindow("mystery-1", "Mystery")).toBe(CURSOR_FALLBACK_CONTEXT_WINDOW);
    expect(CURSOR_FALLBACK_CONTEXT_WINDOW).toBe(200_000);
  });
});
