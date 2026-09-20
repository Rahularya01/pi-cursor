import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ExecServerMessageSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
  TtftBreakdownSchema,
} from "../src/proto/agent_pb.js";
import {
  getDriftSignals,
  recordUnknownFields,
  resetDriftSignalsForTests,
} from "../src/stream/drift.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import type { StreamState } from "../src/stream/types.js";

function unknownFieldNos(
  msg: { $unknown?: readonly { no: number }[] } | null | undefined,
): number[] {
  return [...new Set((msg?.$unknown ?? []).map((f) => f.no))].sort((a, b) => a - b);
}

function emptyState(): StreamState {
  return {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    turnEnded: false,
  };
}

beforeEach(() => {
  resetDriftSignalsForTests();
});

describe("Cursor 3.18.9 additive envelope fields", () => {
  it("round-trips InteractionUpdate.message_started_at_ms without $unknown", () => {
    const msg = create(InteractionUpdateSchema, {
      message: {
        case: "textDelta",
        value: create(TextDeltaUpdateSchema, { text: "ok" }),
      },
      messageStartedAtMs: 1_725_000_000_000n,
    });
    const round = fromBinary(InteractionUpdateSchema, toBinary(InteractionUpdateSchema, msg));
    expect(round.messageStartedAtMs).toBe(1_725_000_000_000n);
    expect(round.message.case).toBe("textDelta");
    expect(unknownFieldNos(round)).toEqual([]);
  });

  it("round-trips ExecServerMessage.accept_hook_additional_contexts without $unknown", () => {
    const msg = create(ExecServerMessageSchema, {
      id: 9,
      execId: "exec-9",
      acceptHookAdditionalContexts: true,
    });
    const round = fromBinary(ExecServerMessageSchema, toBinary(ExecServerMessageSchema, msg));
    expect(round.acceptHookAdditionalContexts).toBe(true);
    expect(unknownFieldNos(round)).toEqual([]);
  });

  it("round-trips ConversationStateStructure start timestamp fields without $unknown", () => {
    const msg = create(ConversationStateStructureSchema, {
      conversationStartedTimestampMs: 1_725_000_000_000n,
      conversationStartedTimeZone: "America/Halifax",
    });
    const round = fromBinary(
      ConversationStateStructureSchema,
      toBinary(ConversationStateStructureSchema, msg),
    );
    expect(round.conversationStartedTimestampMs).toBe(1_725_000_000_000n);
    expect(round.conversationStartedTimeZone).toBe("America/Halifax");
    expect(unknownFieldNos(round)).toEqual([]);
  });

  it("round-trips AgentServerMessage.ttft_breakdown as a sibling of the oneof", () => {
    const msg = create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
          messageStartedAtMs: 42n,
        }),
      },
      ttftBreakdown: create(TtftBreakdownSchema, {
        serverFirstTokenMs: 12.5,
        preStreamSetupMs: 1,
        waitForFirstEventMs: 2,
        providerTtftMs: 3,
        slowPoolWaitMs: 4,
      }),
    });
    const round = fromBinary(AgentServerMessageSchema, toBinary(AgentServerMessageSchema, msg));
    expect(round.message.case).toBe("interactionUpdate");
    expect(round.ttftBreakdown?.serverFirstTokenMs).toBe(12.5);
    expect(unknownFieldNos(round)).toEqual([]);
    expect(
      unknownFieldNos(round.message.case === "interactionUpdate" ? round.message.value : undefined),
    ).toEqual([]);
  });

  it("does not record wire-drift when Cursor 3.18.9 envelope fields are present", () => {
    const serverMessage = create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "textDelta",
            value: create(TextDeltaUpdateSchema, { text: "hi" }),
          },
          messageStartedAtMs: 99n,
        }),
      },
      ttftBreakdown: create(TtftBreakdownSchema, { serverFirstTokenMs: 1 }),
    });
    recordUnknownFields("AgentServerMessage.interactionUpdate", serverMessage);
    recordUnknownFields("interactionUpdate.payload", serverMessage.message.value);
    expect(getDriftSignals()).toEqual([]);

    const texts: string[] = [];
    const progress = processServerMessage(
      serverMessage,
      new Map(),
      [],
      () => {},
      emptyState(),
      (text) => {
        texts.push(text);
      },
      () => {},
    );
    expect(progress).toBe("work");
    expect(texts).toEqual(["hi"]);
    expect(getDriftSignals()).toEqual([]);
  });
});
