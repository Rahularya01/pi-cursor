import assert from "node:assert/strict";
import {
  isContextModeSideChannelText,
  normalizeMessagesForCursor,
  parseMessages,
} from "../src/stream/native-core.ts";

type Msg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

const injection = [
  "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute > ctx_execute_file > ctx_search.",
  "Read/edit files → ctx_execute_file. Multi-command research → ctx_batch_execute.",
  "Web pages → ctx_fetch_and_index then ctx_search. Index docs → ctx_index.",
  "Stats → ctx_stats. Doctor → ctx_doctor. Upgrade → ctx_upgrade. Purge → ctx_purge.",
  "",
  '<session_state source="compaction">',
  "<session_mode>implement</session_mode>",
  "</session_state>",
].join("\n");

assert.equal(isContextModeSideChannelText(injection), true);
assert.equal(isContextModeSideChannelText("please implement dual auth"), false);

const input: Msg[] = [
  { role: "system", content: "You are Pi." },
  { role: "user", content: "implement dual auth for cursor cli + oauth" },
  { role: "user", content: injection },
];

const normalized = normalizeMessagesForCursor(input);

const users = normalized.filter((m) => m.role === "user");
assert.equal(users.length, 1);
assert.equal(users[0]?.content, "implement dual auth for cursor cli + oauth");

const systemMsg = normalized.find((m) => m.role === "system");
const system = String(systemMsg?.content ?? "");
assert.match(system, /provider_context source="context-mode"/);
assert.match(system, /Prioritize the user's actual request/);
assert.match(system, /session_mode/);
assert.match(system, /implement/);

const parsed = parseMessages(input);

assert.equal(parsed.userText, "implement dual auth for cursor cli + oauth");
assert.match(parsed.systemPrompt, /provider_context source="context-mode"/);
assert.equal(parsed.turns.length, 0);

// Real consecutive user messages (not context-mode) stay as history + current.
const multiUser = parseMessages([
  { role: "user", content: "first question" },
  { role: "user", content: "second question" },
]);
assert.equal(multiUser.userText, "second question");
assert.equal(multiUser.turns.length, 1);
assert.equal(multiUser.turns[0]?.userText, "first question");

console.error("test-context-mode-normalize: ok");
