import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  GPT56_DEFAULT_CONTEXT_WINDOW,
  GPT56_MAX_PROMPT_TOKENS,
  clampCursorContextWindow,
  inferCursorContextWindow,
  inferCursorMaxOutputTokens,
} from "../src/models/limits.js";
import { FALLBACK_MODELS, modelsFromParameterizedMetadata } from "../src/models/parameterized.js";
import { processModels } from "../src/models/processing.js";
import type { CursorParameterizedModel } from "../src/client/cursor-wire.js";

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

  it("does not treat GPT-5.6 display-name 1M as a 1M window", () => {
    // Cursor's GetUsableModels labels the 272k default "GPT-5.6 Luna 1M High".
    expect(inferCursorContextWindow("gpt-5.6-luna-high", "GPT-5.6 Luna 1M High")).toBe(
      GPT56_DEFAULT_CONTEXT_WINDOW,
    );
    expect(inferCursorContextWindow("gpt-5.6-luna-medium", "GPT-5.6 Luna 1M")).toBe(
      GPT56_DEFAULT_CONTEXT_WINDOW,
    );
    expect(inferCursorContextWindow("gpt-5.6-sol-high", "GPT-5.6 Sol 1M High")).toBe(
      GPT56_DEFAULT_CONTEXT_WINDOW,
    );
    expect(inferCursorContextWindow("gpt-5.6-luna-high-fast", "GPT-5.6 Luna High Fast")).toBe(
      GPT56_DEFAULT_CONTEXT_WINDOW,
    );
  });

  it("caps GPT-5.6 -1m ids at the 500k OpenAI prompt limit", () => {
    expect(inferCursorContextWindow("gpt-5.6-luna-1m-high", "GPT-5.6 Luna 1M High")).toBe(
      GPT56_MAX_PROMPT_TOKENS,
    );
    expect(inferCursorContextWindow("gpt-5.6-terra-1m-medium", "GPT-5.6 Terra 1M")).toBe(
      GPT56_MAX_PROMPT_TOKENS,
    );
  });
});

describe("clampCursorContextWindow", () => {
  it("caps GPT-5.6 1M parameterized windows at 500k and leaves Claude 1M alone", () => {
    expect(clampCursorContextWindow("gpt-5.6-luna", "GPT-5.6 Luna", 1_000_000)).toBe(
      GPT56_MAX_PROMPT_TOKENS,
    );
    expect(clampCursorContextWindow("gpt-5.6-luna-1m", "GPT-5.6 Luna 1M", 1_000_000)).toBe(
      GPT56_MAX_PROMPT_TOKENS,
    );
    expect(clampCursorContextWindow("claude-4.6-opus-high", "Opus 4.6 1M", 1_000_000)).toBe(
      1_000_000,
    );
    expect(clampCursorContextWindow("gpt-5.6-luna-high", "GPT-5.6 Luna", 272_000)).toBe(272_000);
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

describe("GPT-5.6 Luna parameterized catalog", () => {
  const luna: CursorParameterizedModel = {
    name: "gpt-5.6-luna",
    clientDisplayName: "GPT-5.6 Luna",
    supportsMaxMode: true,
    contextTokenLimit: 272_000,
    contextTokenLimitForMaxMode: 1_000_000,
    variants: [
      {
        isMaxMode: false,
        parameters: [
          { id: "context", value: "272k" },
          { id: "reasoning", value: "high" },
          { id: "fast", value: "false" },
        ],
      },
      {
        isMaxMode: true,
        parameters: [
          { id: "context", value: "1m" },
          { id: "reasoning", value: "high" },
          { id: "fast", value: "false" },
        ],
      },
    ],
  };

  it("registers the 272k default and caps the 1m variant at 500k", () => {
    const rows = modelsFromParameterizedMetadata([luna]);
    const defaultHigh = rows.find((m) => m.id === "gpt-5.6-luna-high");
    const oneMHigh = rows.find((m) => m.id === "gpt-5.6-luna-1m-high");
    expect(defaultHigh?.contextWindow).toBe(GPT56_DEFAULT_CONTEXT_WINDOW);
    expect(oneMHigh?.contextWindow).toBe(GPT56_MAX_PROMPT_TOKENS);
  });

  it("grouped Pi model ids inherit the 500k cap so auto-compaction fires in time", () => {
    const processed = processModels(modelsFromParameterizedMetadata([luna]));
    const grouped1m = processed.find((m) => m.id === "gpt-5.6-luna-1m");
    const groupedDefault = processed.find((m) => m.id === "gpt-5.6-luna");
    expect(groupedDefault?.contextWindow).toBe(GPT56_DEFAULT_CONTEXT_WINDOW);
    expect(grouped1m?.contextWindow).toBe(GPT56_MAX_PROMPT_TOKENS);
  });

  it("caps a cached 1M raw Luna row even when parameterized discovery is empty", () => {
    const processed = processModels([
      {
        id: "gpt-5.6-luna-high",
        name: "GPT-5.6 Luna 1M High",
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
    ]);
    expect(processed).toHaveLength(1);
    expect(processed[0]?.id).toBe("gpt-5.6-luna");
    expect(processed[0]?.contextWindow).toBe(GPT56_MAX_PROMPT_TOKENS);
  });
});
