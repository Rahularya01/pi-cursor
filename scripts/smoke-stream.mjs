/**
 * Live one-shot stream smoke.
 * Usage: CURSOR_ACCESS_TOKEN=... node --import tsx scripts/smoke-stream.mjs
 */
import { createCursorNativeStream } from "../src/stream/native-core.ts";

const token = process.env.CURSOR_ACCESS_TOKEN?.trim();
if (!token) {
  console.error("Set CURSOR_ACCESS_TOKEN");
  process.exit(1);
}

const streamFn = createCursorNativeStream({
  getAccessToken: async () => token,
  getNoReasoningEffortByModelId: () => new Map(),
  getRawModelRoutingByModelId: () => new Map(),
});

const model = {
  id: process.env.CURSOR_SMOKE_MODEL || "composer-2",
  name: "smoke",
  provider: "cursor",
  api: "cursor-native",
  baseUrl: "https://agentn.us.api5.cursor.sh",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const stream = streamFn(
  model,
  {
    systemPrompt: "Reply with the single word pong.",
    messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
    tools: [],
  },
  { temperature: 0, maxTokens: 64 },
);

for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta || "");
  if (event.type === "error") {
    console.error("\nerror:", event.error?.errorMessage || event);
    process.exit(1);
  }
  if (event.type === "done") {
    console.log("\nstop:", event.reason);
  }
}
console.log("smoke-stream: ok");
