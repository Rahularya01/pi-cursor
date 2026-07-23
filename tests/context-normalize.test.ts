import { describe, expect, it } from "vitest";
import {
  isContextModeSideChannelText,
  normalizeMessagesForCursor,
} from "../src/stream/context-normalize.js";

const injection = [
  "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute > ctx_execute_file > ctx_search.",
  "Read/edit files → ctx_execute_file. Multi-command research → ctx_batch_execute.",
  "",
  '<session_state source="compaction">',
  "<session_mode>implement</session_mode>",
  "</session_state>",
].join("\n");

describe("context-mode normalization", () => {
  it("detects side-channel text", () => {
    expect(isContextModeSideChannelText(injection)).toBe(true);
    expect(isContextModeSideChannelText("[context] session resume block")).toBe(true);
    expect(isContextModeSideChannelText("<compaction summary>prior work</compaction>")).toBe(true);
    expect(isContextModeSideChannelText("please implement dual auth")).toBe(false);
  });

  it("moves side-channel user messages into the system prompt", () => {
    const normalized = normalizeMessagesForCursor([
      { role: "system", content: "You are Pi." },
      { role: "user", content: "implement dual auth for cursor cli + oauth" },
      { role: "user", content: injection },
    ]);

    const users = normalized.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.content).toBe("implement dual auth for cursor cli + oauth");

    const system = String(normalized.find((m) => m.role === "system")?.content ?? "");
    expect(system).toMatch(/provider_context source="context-mode"/);
    expect(system).toMatch(/Prioritize the user's actual request/);
    expect(system).toMatch(/session_mode/);
  });
});
