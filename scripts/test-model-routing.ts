import assert from "node:assert/strict";
import { resolveModelId } from "../src/stream/native-core.ts";

assert.equal(resolveModelId("gpt-5.5", "high"), "gpt-5.5-high");
assert.equal(resolveModelId("gpt-5.5-fast", "medium"), "gpt-5.5-medium-fast");
assert.equal(resolveModelId("claude-4.6-opus-thinking", "max"), "claude-4.6-opus-max-thinking");
assert.equal(resolveModelId("composer-2"), "composer-2");

console.log("test-model-routing: ok");
