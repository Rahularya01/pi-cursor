import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  inferCursorContextWindow,
  inferCursorMaxOutputTokens,
} from "../src/models/limits.js";
import { FALLBACK_MODELS } from "../src/models/parameterized.js";

describe("inferCursorContextWindow", () => {
  it("reads the 1M marker from either the id or the display name", () => {
    expect(inferCursorContextWindow("claude-4-sonnet-1m", "Sonnet 4 1M")).toBe(1_000_000);
    expect(inferCursorContextWindow("claude-4.5-sonnet", "Sonnet 4.5 1M")).toBe(1_000_000);
    expect(inferCursorContextWindow("gpt-5.5-1m-high", "GPT-5.5 1M High")).toBe(1_000_000);
  });

  it("reads the 272K marker and otherwise falls back to 200K", () => {
    expect(inferCursorContextWindow("gpt-5.5-high", "GPT-5.5 272K High")).toBe(272_000);
    expect(inferCursorContextWindow("composer-2", "Composer 2")).toBe(200_000);
  });
});

describe("inferCursorMaxOutputTokens", () => {
  it("raises Claude 4.6+ to 128K", () => {
    expect(inferCursorMaxOutputTokens("claude-4.6-opus-high", "Opus 4.6 1M")).toBe(128_000);
    expect(inferCursorMaxOutputTokens("claude-4.6-sonnet-medium", "Sonnet 4.6 1M")).toBe(128_000);
  });

  it("raises the GPT-5 family to 128K", () => {
    expect(inferCursorMaxOutputTokens("gpt-5.5-high", "GPT-5.5 272K High")).toBe(128_000);
    expect(inferCursorMaxOutputTokens("gpt-5-mini", "GPT-5 Mini")).toBe(128_000);
  });

  it("leaves Claude 4.5 and older, and every other family, at the 64K floor", () => {
    for (const [id, name] of [
      ["claude-4-sonnet", "Sonnet 4"],
      ["claude-4.5-sonnet", "Sonnet 4.5 1M"],
      ["claude-4.5-opus-high", "Opus 4.5"],
      ["claude-4.5-haiku", "Haiku 4.5"],
      ["composer-2", "Composer 2"],
      ["gemini-3.1-pro", "Gemini 3.1 Pro"],
      ["grok-4-20", "Grok 4.20"],
      ["kimi-k2.5", "Kimi K2.5"],
      ["default", "Auto"],
    ] as const) {
      expect(inferCursorMaxOutputTokens(id, name)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    }
  });
});

describe("bundled fallback catalog", () => {
  // The catalog is a snapshot of a live discovery response and had drifted: every
  // "1M" Claude row claimed a 200K window. Both columns are derived now, so this
  // guards the derivation rather than the file.
  it("derives both limit columns from the model id and name", () => {
    for (const model of FALLBACK_MODELS) {
      expect(model.contextWindow).toBe(inferCursorContextWindow(model.id, model.name));
      expect(model.maxTokens).toBe(inferCursorMaxOutputTokens(model.id, model.name));
    }
  });

  it("reports the full window for the 1M Claude rows", () => {
    const oneMillion = FALLBACK_MODELS.filter((m) => /\b1M\b/.test(m.name));
    expect(oneMillion.length).toBeGreaterThan(0);
    for (const model of oneMillion) expect(model.contextWindow).toBe(1_000_000);
  });
});
