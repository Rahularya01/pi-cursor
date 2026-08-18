import { describe, expect, it } from "vitest";
import {
  isContextModeSideChannelText,
  isNoOpSideChannelText,
  isPureContextModeSideChannelText,
  normalizeMessagesForCursor,
  splitUserTextAndSideChannel,
  systemPromptHasSessionMemory,
} from "../src/stream/context-normalize.js";
import { parseMessages } from "../src/stream/message-parsing.js";

const piLensInjection =
  "[pi-lens automated context — not a user request] pi-lens: 1 file(s) were autofixed " +
  "by another pi-lens instance (e.g. a subagent's): " +
  "/Users/rahularya/Projects/tools/pi-cursor/tests/request-size.test.ts — working-tree " +
  "changes to these are expected; re-read before editing.";

const injection = [
  "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute > ctx_execute_file > ctx_search.",
  "Read/edit files → ctx_execute_file. Multi-command research → ctx_batch_execute.",
  "",
  '<session_state source="compaction">',
  "<session_mode>implement</session_mode>",
  "<summary>You were editing README.md, AGENTS.md, package.json before this message.</summary>",
  "</session_state>",
].join("\n");

describe("context-mode normalization", () => {
  it("detects side-channel text", () => {
    expect(isContextModeSideChannelText(injection)).toBe(true);
    expect(isContextModeSideChannelText("[context] session resume block")).toBe(true);
    expect(isContextModeSideChannelText("<compaction summary>prior work</compaction>")).toBe(true);
    expect(isContextModeSideChannelText(piLensInjection)).toBe(true);
    expect(
      isContextModeSideChannelText(
        "[pi-lens automated check — not a user request] Address blockers before continuing",
      ),
    ).toBe(true);
    expect(isContextModeSideChannelText("please implement dual auth")).toBe(false);
    expect(isPureContextModeSideChannelText(injection)).toBe(true);
    expect(isPureContextModeSideChannelText(`hi\n\n${injection}`)).toBe(false);
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
    expect(system).toMatch(/recovered conversation context/i);
    expect(system).toMatch(/session_mode/);
  });

  it("splits a real prompt that was concatenated with a context-mode injection", () => {
    const { userText, sideText } = splitUserTextAndSideChannel(`hi\n\n${injection}`);
    expect(userText).toBe("hi");
    expect(sideText).toMatch(/context-mode active/);
    expect(sideText).toMatch(/session_state/);

    const normalized = normalizeMessagesForCursor([
      { role: "system", content: "You are Pi." },
      { role: "user", content: `hi\n\n${injection}` },
    ]);
    const users = normalized.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.content).toBe("hi");

    const parsed = parseMessages(normalized as any);
    expect(parsed.userText).toBe("hi");
    expect(parsed.systemPrompt).toMatch(/provider_context source="context-mode"/);
    // Real user text must not be parked only inside provider_context.
    expect(parsed.systemPrompt).not.toMatch(
      /<provider_context[^>]*>\s*hi\s*\n\s*context-mode active/i,
    );
  });

  it("keeps a short trailing user task after a leading session_state block", () => {
    const mixed = `${injection}\n\nhi`;
    const { userText, sideText } = splitUserTextAndSideChannel(mixed);
    expect(userText).toBe("hi");
    expect(sideText).toMatch(/session_state/);

    const parsed = parseMessages([
      { role: "system", content: "You are Pi." },
      { role: "user", content: mixed },
    ] as any);
    expect(parsed.userText).toBe("hi");
  });

  it("keeps prose that mentions session_state mid-sentence as the user task", () => {
    const prose = "please explain what a <session_state> block is used for";
    const normalized = normalizeMessagesForCursor([{ role: "user", content: prose }]);
    const users = normalized.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(String(users[0]?.content)).toMatch(/please explain/);
  });

  it("keeps pi-lens automated context out of the active user turn", () => {
    for (const userMessages of [
      [
        { role: "user" as const, content: "hi" },
        { role: "user" as const, content: piLensInjection },
      ],
      [{ role: "user" as const, content: `hi\n\n${piLensInjection}` }],
    ]) {
      const parsed = parseMessages([
        { role: "system", content: "You are Pi." },
        ...userMessages,
      ] as any);
      expect(parsed.userText).toBe("hi");
      expect(parsed.turns).toHaveLength(0);
      expect(parsed.systemPrompt).toContain(piLensInjection);
      expect(parsed.systemPrompt).toMatch(/latest user message is the only task/i);
    }
  });

  it("drops empty hierarchy + mode-only session_state side channels", () => {
    const emptyInjection = [
      "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute > ctx_execute_file > ctx_search.",
      "Read/edit files → ctx_execute_file. Multi-command research → ctx_batch_execute.",
      "",
      '<session_state source="compaction">',
      "<session_mode>investigate</session_mode>",
      "</session_state>",
    ].join("\n");
    expect(isNoOpSideChannelText(emptyInjection)).toBe(true);

    const normalized = normalizeMessagesForCursor([
      { role: "system", content: "You are Pi." },
      { role: "user", content: `hi\n\n${emptyInjection}` },
    ]);
    const system = String(normalized.find((m) => m.role === "system")?.content ?? "");
    expect(system).not.toMatch(/provider_context/);
    expect(normalized.filter((m) => m.role === "user")).toHaveLength(1);
    expect(normalized.find((m) => m.role === "user")?.content).toBe("hi");
  });

  it("keeps a long trailing user task after a leading session_state block", () => {
    const task = `please continue the auth work and ${"x".repeat(600)}`;
    const mixed = `${injection}\n\n${task}`;
    const { userText, sideText } = splitUserTextAndSideChannel(mixed);
    expect(userText).toBe(task);
    expect(sideText).toMatch(/session_state/);
  });

  it("keeps a short but useful compaction summary instead of treating it as a no-op", () => {
    const short = [
      "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute.",
      '<session_state source="compaction">',
      "<session_mode>implement</session_mode>",
      "<summary>You were implementing OAuth in src/auth/oauth.ts.</summary>",
      "</session_state>",
    ].join("\n");
    expect(isNoOpSideChannelText(short)).toBe(false);

    const normalized = normalizeMessagesForCursor([
      { role: "system", content: "You are Pi." },
      { role: "user", content: `continue\n\n${short}` },
    ]);
    const system = String(normalized.find((m) => m.role === "system")?.content ?? "");
    expect(system).toMatch(/recovered conversation context/i);
    expect(system).toMatch(/OAuth/);
  });

  it("detects folded session memory in the system prompt", () => {
    expect(systemPromptHasSessionMemory("You are Pi.")).toBe(false);
    expect(
      systemPromptHasSessionMemory('<provider_context source="context-mode">x</provider_context>'),
    ).toBe(true);
  });
});
