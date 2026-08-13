import { afterEach, describe, expect, it } from "vitest";
import {
  __testInternals,
  type ParsedTurn,
  type StoredConversation,
} from "../src/stream/native-core.js";
import { planRecovery } from "../src/stream/recovery.js";

afterEach(() => {
  __testInternals.conversationStates.clear();
});

function storedConversation(): StoredConversation {
  return {
    conversationId: "conv-1",
    checkpoint: null,
    sessionScoped: true,
    sessionId: "session-1",
    blobStore: new Map(),
    lastAccessMs: 0,
  };
}

describe("aborted native streams", () => {
  it("retains the latest checkpoint and blob store for the retry", () => {
    const convKey = "conv-key";
    const stored = storedConversation();
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const currentTurn: ParsedTurn = {
      userText: "continue the task",
      steps: [{ kind: "assistantText", text: "Partial answer" }],
    };
    const checkpoint = new Uint8Array([1, 2, 3]);
    const blobStore = new Map([["blob-1", new Uint8Array([4, 5, 6])]]);
    __testInternals.conversationStates.set(convKey, stored);

    __testInternals.persistAbortedConversationState(
      convKey,
      checkpoint,
      blobStore,
      completedTurns,
      currentTurn,
    );

    expect(stored.checkpoint).toBe(checkpoint);
    expect(stored.checkpointTurnCount).toBe(2);
    expect(stored.checkpointHistoryFingerprint).toBe(
      __testInternals.fingerprintCompletedTurns([...completedTurns, currentTurn]),
    );
    expect(stored.blobStore.get("blob-1")).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("retains blobs when Cursor has not produced a checkpoint", () => {
    const convKey = "conv-key";
    const stored = storedConversation();
    const blobStore = new Map([["blob-1", new Uint8Array([4, 5, 6])]]);
    __testInternals.conversationStates.set(convKey, stored);

    __testInternals.persistAbortedConversationState(convKey, null, blobStore, [], {
      userText: "continue the task",
      steps: [],
    });

    expect(stored.checkpoint).toBeNull();
    expect(stored.blobStore.get("blob-1")).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("recover via checkpoint after idle-timeout persistence (issue #5 end-to-end)", () => {
    // https://github.com/Rahularya01/pi-cursor/issues/5: the idle watchdog fired on a parked
    // tool stream, persistAbortedConversationState with pending execs must retain both the
    // checkpoint and its mid-pause snapshot, discardStaleCheckpointIfNeeded must not drop the
    // valid checkpoint, and planRecovery must resume via the checkpoint instead of skipping
    // with stale_checkpoint.
    const convKey = "conv-key";
    const stored = storedConversation();
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const checkpoint = new Uint8Array([0x0a, 0x00]); // minimal decodable protobuf
    __testInternals.conversationStates.set(convKey, stored);

    __testInternals.persistAbortedConversationState(
      convKey,
      checkpoint,
      new Map(),
      completedTurns,
      { userText: "run a command", steps: [] },
      [{ toolCallId: "call-1", toolName: "shell" }],
    );

    expect(stored.checkpoint).toBe(checkpoint);
    expect(stored.midPausePendingToolCalls).toEqual([{ toolCallId: "call-1", toolName: "shell" }]);

    __testInternals.discardStaleCheckpointIfNeeded(stored, completedTurns, "r1", convKey);
    expect(stored.checkpoint).not.toBeNull();

    const decision = planRecovery({
      stored,
      toolResults: [{ toolCallId: "call-1", content: "ok" }],
      completedTurns,
      inFlightTurn: {
        userText: "run a command",
        steps: [{ kind: "toolCall", toolCallId: "call-1", toolName: "shell", arguments: {} }],
      },
      sessionId: "session-1",
      requestId: "r1",
      convKey,
    });
    expect(decision.kind).toBe("recover");
    if (decision.kind === "recover") {
      expect(decision.checkpoint).toBe(checkpoint);
    }
  });

  it("preserves a mid-pause snapshot when an interrupted stream awaits tool results", () => {
    const convKey = "conv-key";
    const stored = storedConversation();
    const completedTurns: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const checkpoint = new Uint8Array([1, 2, 3]);
    __testInternals.conversationStates.set(convKey, stored);

    __testInternals.persistAbortedConversationState(
      convKey,
      checkpoint,
      new Map(),
      completedTurns,
      {
        userText: "run a command",
        steps: [{ kind: "toolCall", toolCallId: "call-1", toolName: "shell", arguments: {} }],
      },
      [{ toolCallId: "call-1", toolName: "shell" }],
    );

    expect(stored.checkpoint).toBe(checkpoint);
    expect(stored.checkpointTurnCount).toBe(completedTurns.length);
    expect(stored.checkpointHistoryFingerprint).toBe(
      __testInternals.fingerprintCompletedTurns(completedTurns),
    );
    expect(stored.midPausePendingToolCalls).toEqual([{ toolCallId: "call-1", toolName: "shell" }]);
    expect(stored.midPauseTurnCount).toBe(completedTurns.length);
  });
});
