import { create, toBinary } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it } from "vitest";

import { ConversationStateStructureSchema } from "../src/proto/agent_pb.js";
import {
  clientCompletedHistory,
  clientInFlightTurn,
  liveTranscript,
  withSyntheticCurrentTurn,
} from "../src/stream/client-transcript.js";
import { fingerprintCompletedTurns, planRecovery } from "../src/stream/recovery.js";
import {
  commitStoredCheckpointMidPause,
  conversationStates,
  discardStaleCheckpointIfNeeded,
} from "../src/stream/session-state.js";
import type {
  ParsedToolCallStep,
  ParsedTurn,
  StoredConversation,
  ToolResultInfo,
} from "../src/stream/types.js";

function toolCall(id: string, result?: string): ParsedToolCallStep {
  return {
    kind: "toolCall",
    toolCallId: id,
    toolName: "bash",
    arguments: { command: `run ${id}` },
    ...(result ? { result: { content: result, isError: false } } : {}),
  };
}

function storedConversation(partial: Partial<StoredConversation> = {}): StoredConversation {
  return {
    conversationId: "conv-1",
    checkpoint: null,
    sessionScoped: true,
    sessionId: "session-1",
    blobStore: new Map(),
    lastAccessMs: Date.now(),
    ...partial,
  };
}

describe("client transcript identity across recovery", () => {
  beforeEach(() => {
    conversationStates.clear();
  });

  // The production failure: a long agent turn takes several tool rounds, loses its bridge once,
  // continues from a checkpoint — which replaces the wire turn with a synthetic one — and then
  // loses the bridge again. The second loss must still be recoverable.
  it("recovers a bridge loss that follows an earlier checkpoint continuation", () => {
    const convKey = "conv-key";
    const stored = storedConversation();
    conversationStates.set(convKey, stored);

    // Rounds 1 and 2 ran on the original bridge, so pi's turn holds both.
    const wireTurnBeforeLoss: ParsedTurn = {
      userText: "solve the obligation",
      steps: [toolCall("call-a"), toolCall("call-b")],
    };
    let transcript = liveTranscript([]);

    // Checkpoint continuation after the first bridge loss: the wire turn is replaced by a
    // synthetic one, so from here the wire only ever sees round 3.
    transcript = withSyntheticCurrentTurn(transcript, wireTurnBeforeLoss);
    const syntheticWireTurn: ParsedTurn = {
      userText: "[continue]",
      steps: [toolCall("call-c")],
    };

    commitStoredCheckpointMidPause(
      stored,
      null,
      new Map(),
      transcript,
      [{ toolCallId: "call-c", toolName: "bash" }],
      convKey,
    );

    // pi answers every outstanding call and replays its own view of the turn.
    const toolResults: ToolResultInfo[] = [
      { toolCallId: "call-a", content: "a" },
      { toolCallId: "call-b", content: "b" },
      { toolCallId: "call-c", content: "c" },
    ];
    const clientInFlight: ParsedTurn = {
      userText: "solve the obligation",
      steps: [toolCall("call-a", "a"), toolCall("call-b", "b"), toolCall("call-c", "c")],
    };

    const decision = planRecovery({
      stored,
      toolResults,
      completedTurns: transcript.completedTurns,
      inFlightTurn: clientInFlightTurn(transcript, syntheticWireTurn),
      sessionId: "session-1",
      requestId: "req-1",
      convKey,
    });

    expect(decision.kind).toBe("rebuild_full_history");
    if (decision.kind === "rebuild_full_history") {
      expect(decision.inFlightTurn.steps.map((s) => (s as ParsedToolCallStep).toolCallId)).toEqual([
        "call-a",
        "call-b",
        "call-c",
      ]);
    }

    // The regression this guards: matching the bridge's own turn instead of pi's sees only the
    // round that survived the continuation, and every later loss in the turn is fatal.
    const wireOnly = planRecovery({
      stored,
      toolResults,
      completedTurns: [],
      inFlightTurn: syntheticWireTurn,
      sessionId: "session-1",
      requestId: "req-1",
      convKey,
    });
    expect(wireOnly.kind).toBe("skip");
    if (wireOnly.kind === "skip") expect(wireOnly.reason).toBe("pending_tool_call_mismatch");

    expect(clientInFlight.steps).toHaveLength(3);
  });

  it("snapshots pi's completed-turn count after a full-history rebuild", () => {
    const convKey = "conv-key";
    const stored = storedConversation();
    conversationStates.set(convKey, stored);

    const completed: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const clientInFlight: ParsedTurn = { userText: "now", steps: [toolCall("call-a", "a")] };

    // A rebuild folds pi's in-flight turn into the wire history, so wire completed turns are one
    // ahead of pi's for the rest of the turn.
    const transcript = withSyntheticCurrentTurn(
      { kind: "recovered", completedTurns: completed, inFlightTurn: clientInFlight },
      { userText: "[recovered]", steps: [toolCall("call-b")] },
    );

    commitStoredCheckpointMidPause(
      stored,
      null,
      new Map(),
      transcript,
      [{ toolCallId: "call-b", toolName: "bash" }],
      convKey,
    );

    expect(stored.midPauseTurnCount).toBe(completed.length);
    expect(stored.midPauseHistoryFingerprint).toBe(fingerprintCompletedTurns(completed));

    const decision = planRecovery({
      stored,
      toolResults: [
        { toolCallId: "call-a", content: "a" },
        { toolCallId: "call-b", content: "b" },
      ],
      completedTurns: completed,
      inFlightTurn: clientInFlightTurn(transcript, { userText: "", steps: [] }),
      sessionId: "session-1",
      requestId: "req-1",
      convKey,
    });
    expect(decision.kind).toBe("rebuild_full_history");
  });

  it("keeps the checkpoint usable on the next turn after a recovery", () => {
    const convKey = "conv-key";
    const completed: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const clientInFlight: ParsedTurn = {
      userText: "now",
      steps: [toolCall("call-a", "a")],
    };
    const transcript = withSyntheticCurrentTurn(
      { kind: "recovered", completedTurns: completed, inFlightTurn: clientInFlight },
      { userText: "[recovered]", steps: [] },
    );
    const syntheticWireTurn: ParsedTurn = {
      userText: "[recovered]",
      steps: [{ kind: "assistantText", text: "done" }],
    };

    const history = clientCompletedHistory(transcript, syntheticWireTurn);
    const stored = storedConversation({
      checkpoint: toBinary(
        ConversationStateStructureSchema,
        create(ConversationStateStructureSchema, {}),
      ),
      checkpointSource: "upstream",
      checkpointTurnCount: history.length,
      checkpointHistoryFingerprint: fingerprintCompletedTurns(history),
    });
    conversationStates.set(convKey, stored);

    // pi's next request replays the finished turn: original user text, its tool call and result,
    // then the assistant text produced after recovery. The recovery wrapper text is not pi's.
    const replayed: ParsedTurn[] = [
      ...completed,
      {
        userText: "now",
        steps: [toolCall("call-a", "a"), { kind: "assistantText", text: "done" }],
      },
    ];
    expect(fingerprintCompletedTurns(replayed)).toBe(stored.checkpointHistoryFingerprint);

    discardStaleCheckpointIfNeeded(stored, replayed, "req-2", convKey);
    expect(stored.checkpoint).not.toBeNull();
    expect(stored.conversationId).toBe("conv-1");
  });
});
