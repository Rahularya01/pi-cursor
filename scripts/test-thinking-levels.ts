import assert from "node:assert/strict";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { buildEffortMap, modelConfig, processModels } from "../src/index.ts";

assert.deepEqual(buildEffortMap(new Set(["none", "low", "medium", "high", "xhigh"])), {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null,
});

const [model] = processModels([
  {
    id: "gpt-5.4-low",
    name: "GPT 5.4 Low",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "gpt-5.4-high",
    name: "GPT 5.4 High",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "gpt-5.4-max",
    name: "GPT 5.4 Max",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
]);

assert.ok(model);
const config = modelConfig(model);
assert.equal(config.reasoning, true);
assert.deepEqual(config.thinkingLevelMap, {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
});
assert.deepEqual(
  getSupportedThinkingLevels({
    ...config,
    api: "cursor-native",
    provider: "cursor",
    baseUrl: "https://agent.cursor.sh",
  }),
  ["low", "high", "max"],
);

console.log("test-thinking-levels: ok");
