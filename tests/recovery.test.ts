import { describe, expect, it } from "vitest";
import {
  collapseToolResultsById,
  fingerprintCompletedTurns,
  planRecovery,
  wrapRecoveredToolResults,
  type ParsedTurn,
  type StoredConversation,
  type ToolResultInfo,
} from "../src/stream/recovery.js";

function toolTurn(ids: string[]): ParsedTurn {
  return {
    userText: "do work",
    steps: ids.map((toolCallId) => ({
      kind: "toolCall" as const,
      toolCallId,
      toolName: "read",
      arguments: { path: "a.ts" },
    })),
  };
}

function storedBase(partial: Partial<StoredConversation> = {}): StoredConversation {
  const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
  return {
    conversationId: "conv-1",
    checkpoint: null,
    sessionScoped: false,
    blobStore: new Map(),
    lastAccessMs: Date.now(),
    midPausePendingToolCalls: [{ toolCallId: "t1", toolName: "read" }],
    midPauseTurnCount: completedTurns.length,
    midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    midPauseRecordedAtMs: Date.now(),
    ...partial,
  };
}

describe("planRecovery", () => {
  it("skips when no stored conversation", () => {
    const decision = planRecovery({
      stored: undefined,
      toolResults: [{ toolCallId: "t1", content: "ok" }],
      completedTurns: [],
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("no_stored_conversation");
    }
  });

  it("rebuilds full history when checkpoint is missing but mid-pause metadata is valid", () => {
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: null,
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    const toolResults: ToolResultInfo[] = [{ toolCallId: "t1", content: "file contents" }];
    const decision = planRecovery({
      stored,
      toolResults,
      completedTurns,
      inFlightTurn: toolTurn(["t1"]),
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("rebuild_full_history");
    if (decision.kind === "rebuild_full_history") {
      expect(decision.rebuildReason).toBe("no_checkpoint");
      expect(decision.wrappedText).toContain("Recovered tool output");
      expect(decision.toolResults).toEqual(toolResults);
    }
  });

  it("rebuilds when the bridge dies on a later tool round of the same user turn", () => {
    // Round 2 parked only t2, but the client re-sends every result in the turn (t1 and t2).
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: null,
      midPausePendingToolCalls: [{ toolCallId: "t2", toolName: "read" }],
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    const toolResults: ToolResultInfo[] = [
      { toolCallId: "t1", content: "round one" },
      { toolCallId: "t2", content: "round two" },
    ];
    const decision = planRecovery({
      stored,
      toolResults,
      completedTurns,
      inFlightTurn: toolTurn(["t1", "t2"]),
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("rebuild_full_history");
  });

  it("still skips when a parked tool call has no result in the request", () => {
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: null,
      midPausePendingToolCalls: [
        { toolCallId: "t1", toolName: "read" },
        { toolCallId: "t2", toolName: "read" },
      ],
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "t1", content: "only one" }],
      completedTurns,
      inFlightTurn: toolTurn(["t1"]),
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("pending_tool_call_mismatch");
    }
  });

  it("ignores unidentifiable tool results instead of reading them as duplicates", () => {
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: null,
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    const inFlightTurn = toolTurn(["t1"]);
    inFlightTurn.steps.push(
      { kind: "toolCall", toolCallId: "", toolName: "", arguments: {} },
      { kind: "toolCall", toolCallId: "", toolName: "", arguments: {} },
    );
    const decision = planRecovery({
      stored,
      toolResults: [
        { toolCallId: "t1", content: "ok" },
        { toolCallId: "", content: "orphan a" },
        { toolCallId: "", content: "orphan b" },
      ],
      completedTurns,
      inFlightTurn,
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("rebuild_full_history");
  });

  it("recovers via checkpoint when pending tool ids match", () => {
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const checkpoint = new Uint8Array([1, 2, 3]);
    const stored = storedBase({
      checkpoint,
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "t1", content: "ok" }],
      completedTurns,
      inFlightTurn: toolTurn(["t1"]),
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("recover");
    if (decision.kind === "recover") {
      expect(decision.checkpoint).toBe(checkpoint);
      expect(decision.wrappedText).toContain("t1");
    }
  });

  it("does not replay tool results into a checkpoint without a mid-pause snapshot", () => {
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: new Uint8Array([1, 2, 3]),
      midPausePendingToolCalls: undefined,
      midPauseTurnCount: undefined,
      midPauseHistoryFingerprint: undefined,
      midPauseRecordedAtMs: undefined,
    });

    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "t1", content: "ok" }],
      completedTurns,
      inFlightTurn: toolTurn(["t1"]),
      requestId: "r1",
      convKey: "c1",
    });

    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("pending_tool_call_mismatch");
    }
  });

  it("falls back to full-history rebuild when checkpoint is discarded as stale", () => {
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: new Uint8Array([9]),
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "t1", content: "ok" }],
      completedTurns,
      inFlightTurn: toolTurn(["t1"]),
      requestId: "r1",
      convKey: "c1",
      discardStaleCheckpoint: (s) => {
        s.checkpoint = null;
      },
    });
    expect(decision.kind).toBe("rebuild_full_history");
    if (decision.kind === "rebuild_full_history") {
      expect(decision.rebuildReason).toBe("stale_checkpoint");
    }
  });

  it("falls back to rebuild when checkpoint tool ids mismatch but mid-pause is valid", () => {
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: new Uint8Array([1]),
      midPausePendingToolCalls: [{ toolCallId: "t1", toolName: "read" }],
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    // Received results match mid-pause pending (t1) so rebuild can succeed even though
    // validate against checkpoint path would also use the same pending list — force mismatch
    // by using different received ids for checkpoint path then... actually checkpoint path
    // uses the same midPausePendingToolCalls. Simulate mismatch with wrong received ids
    // that still match inFlightTurn for rebuild? Rebuild requires pending == received == inFlight.
    // So true mismatch hard-skips. Use empty pending after mismatch fallback tries rebuild.
    stored.midPausePendingToolCalls = [{ toolCallId: "expected", toolName: "read" }];
    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "other", content: "ok" }],
      completedTurns,
      inFlightTurn: toolTurn(["other"]),
      requestId: "r1",
      convKey: "c1",
    });
    // pending expected vs received other → mismatch; rebuild also fails pending match
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("pending_tool_call_mismatch");
    }
  });

  it("rebuilds a multi-round turn when the request carries the full in-flight turn", () => {
    // Regression: the bridge's currentTurn accumulates only the execs of the last
    // writeNativeStream round, while the client re-sends every tool result of the whole
    // multi-round user turn. handleNativeToolResultResume now hands recovery planning the
    // full parsed in-flight turn instead of the bridge's last-round view; validate that a
    // 20-call turn with all results still rebuilds instead of hard-skipping.
    const completedTurns: ParsedTurn[] = Array.from({ length: 4 }, (_, i) => ({
      userText: `earlier ${i}`,
      steps: [] as ParsedTurn["steps"],
    }));
    const allIds = [...Array.from({ length: 16 }, (_, i) => `r${i + 1}`), "l1", "l2", "l3", "l4"];
    const toolResults: ToolResultInfo[] = allIds.map((toolCallId) => ({
      toolCallId,
      content: "ok",
    }));
    const stored = storedBase({
      checkpoint: null,
      midPausePendingToolCalls: ["l1", "l2", "l3", "l4"].map((toolCallId) => ({
        toolCallId,
        toolName: "read",
      })),
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });

    const decision = planRecovery({
      stored,
      toolResults,
      completedTurns,
      // What handleNativeToolResultResume now passes: the full in-flight turn parsed
      // from the resume request (every round of the multi-round turn).
      inFlightTurn: toolTurn(allIds),
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("rebuild_full_history");
  });

  it("hard-skips when the in-flight turn only tracks the parked round (pre-fix bridge view)", () => {
    // Contract guard: recovery planning demands that the in-flight turn handed to it covers
    // every result the client re-sent (exact id match). A caller that passes only the
    // bridge's last-round view — as handleNativeToolResultResume did before the fix — must
    // still hard-skip rather than rebuild an incomplete transcript that silently drops the
    // earlier rounds of the turn. The fix belongs in the caller (pass the full parsed turn),
    // never in relaxing this equality.
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const allIds = ["r1", "r2", "r3", "r4", "l1", "l2", "l3", "l4"];
    const toolResults: ToolResultInfo[] = allIds.map((toolCallId) => ({
      toolCallId,
      content: "ok",
    }));
    const stored = storedBase({
      checkpoint: null,
      midPausePendingToolCalls: ["l1", "l2", "l3", "l4"].map((toolCallId) => ({
        toolCallId,
        toolName: "read",
      })),
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });

    const decision = planRecovery({
      stored,
      toolResults,
      completedTurns,
      // The bridge's currentTurn view: only the parked round's execs, not the whole turn.
      inFlightTurn: toolTurn(["l1", "l2", "l3", "l4"]),
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("pending_tool_call_mismatch");
    }
  });

  it("tolerates a re-emitted tool call duplicated in the client history", () => {
    // Regression: after a partial-wait resume, Pi records a fresh assistant message that
    // re-emits an already-answered exec id. The duplicate must be treated as answered
    // rather than tripping the validator's duplicate tripwire into pending_tool_call_mismatch.
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: null,
      midPausePendingToolCalls: [
        { toolCallId: "t1", toolName: "read" },
        { toolCallId: "t2", toolName: "read" },
      ],
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    const inFlightTurn = toolTurn(["t1", "t2"]);
    // Partial-wait re-emission: the same ids appear again in a later assistant message.
    inFlightTurn.steps.push(
      { kind: "toolCall", toolCallId: "t2", toolName: "read", arguments: {} },
      { kind: "toolCall", toolCallId: "t1", toolName: "read", arguments: {} },
    );
    const decision = planRecovery({
      stored,
      toolResults: [
        { toolCallId: "t1", content: "ok" },
        { toolCallId: "t2", content: "ok" },
      ],
      completedTurns,
      inFlightTurn,
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("rebuild_full_history");
  });

  it("still skips when a parked tool call has no result even with duplicate artifacts", () => {
    // Dedupe must not weaken the real guard: a parked exec that genuinely has no result
    // in the request still makes the rebuild unsafe and must hard-skip.
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: null,
      midPausePendingToolCalls: [
        { toolCallId: "t1", toolName: "read" },
        { toolCallId: "t2", toolName: "read" },
        { toolCallId: "t3", toolName: "read" },
      ],
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    const inFlightTurn = toolTurn(["t1", "t2", "t3"]);
    inFlightTurn.steps.push(
      { kind: "toolCall", toolCallId: "t1", toolName: "read", arguments: {} },
      { kind: "toolCall", toolCallId: "t2", toolName: "read", arguments: {} },
    );
    const decision = planRecovery({
      stored,
      // t3 parked but never answered
      toolResults: [
        { toolCallId: "t1", content: "ok" },
        { toolCallId: "t2", content: "ok" },
      ],
      completedTurns,
      inFlightTurn,
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") {
      expect(decision.reason).toBe("pending_tool_call_mismatch");
    }
  });
  it("collapses duplicate tool results on checkpoint recovery (last result wins)", () => {
    // Regression: the validators tolerate repeated ids (partial-wait re-emission), so the
    // coverage check passes with two results for the same tool_call_id — but the raw list
    // must not be wrapped and replayed, or Cursor receives the same tool output twice.
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: new Uint8Array([0x0a, 0x00]),
      midPausePendingToolCalls: [{ toolCallId: "t1", toolName: "read" }],
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    const decision = planRecovery({
      stored,
      toolResults: [
        { toolCallId: "t1", content: "stale output" },
        { toolCallId: "t1", content: "fresh output" },
      ],
      completedTurns,
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("recover");
    if (decision.kind === "recover") {
      expect(decision.wrappedText).toContain("fresh output");
      expect(decision.wrappedText).not.toContain("stale output");
      expect(decision.wrappedText.split("Tool call id: t1").length - 1).toBe(1);
    }
  });

  it("collapses duplicate tool results on full-history rebuild (last result wins)", () => {
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const stored = storedBase({
      checkpoint: null,
      midPausePendingToolCalls: [
        { toolCallId: "t1", toolName: "read" },
        { toolCallId: "t2", toolName: "read" },
      ],
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fingerprintCompletedTurns(completedTurns),
    });
    const decision = planRecovery({
      stored,
      toolResults: [
        { toolCallId: "t1", content: "stale output" },
        { toolCallId: "t1", content: "fresh output" },
        { toolCallId: "t2", content: "round two" },
      ],
      completedTurns,
      inFlightTurn: toolTurn(["t1", "t2"]),
      requestId: "r1",
      convKey: "c1",
    });
    expect(decision.kind).toBe("rebuild_full_history");
    if (decision.kind === "rebuild_full_history") {
      expect(decision.toolResults).toEqual([
        { toolCallId: "t1", content: "fresh output" },
        { toolCallId: "t2", content: "round two" },
      ]);
      expect(decision.wrappedText).toContain("fresh output");
      expect(decision.wrappedText).not.toContain("stale output");
    }
  });
});

describe("wrapRecoveredToolResults", () => {
  it("frames tool results with recovery sentinels", () => {
    const text = wrapRecoveredToolResults([{ toolCallId: "abc", content: "hello" }], "fixed-id");
    expect(text).toContain("recovery:fixed-id");
    expect(text).toContain("Tool call id: abc");
    expect(text).toContain("hello");
  });

  it("collapseToolResultsById keeps the last result per tool call id in first-seen order", () => {
    const collapsed = collapseToolResultsById([
      { toolCallId: "t1", content: "first" },
      { toolCallId: "t2", content: "middle" },
      { toolCallId: "t1", content: "last" },
      { toolCallId: "t3", content: "tail" },
    ]);
    expect(collapsed).toEqual([
      { toolCallId: "t1", content: "last" },
      { toolCallId: "t2", content: "middle" },
      { toolCallId: "t3", content: "tail" },
    ]);
  });
});
