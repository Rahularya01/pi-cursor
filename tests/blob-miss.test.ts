import { afterEach, describe, expect, it } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/proto/agent_pb.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import { conversationStates } from "../src/stream/session-state.js";
import type { StoredConversation, StreamState } from "../src/stream/types.js";

function emptyState(): StreamState {
  return {
    toolCallIndex: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    turnEnded: false,
  };
}

function getBlobMessage(blobId: Uint8Array) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "kvServerMessage",
      value: create(KvServerMessageSchema, {
        message: {
          case: "getBlobArgs",
          value: create(GetBlobArgsSchema, { blobId }),
        },
      }),
    },
  });
}

afterEach(() => {
  conversationStates.clear();
});

describe("getBlobArgs miss must not punch holes", () => {
  it("still returns a blob the store holds", () => {
    const blobId = new Uint8Array([0xab, 0xcd]);
    const blobData = new Uint8Array([1, 2, 3]);
    const store = new Map<string, Uint8Array>([[Buffer.from(blobId).toString("hex"), blobData]]);
    const frames: Uint8Array[] = [];

    expect(
      processServerMessage(
        getBlobMessage(blobId),
        store,
        [],
        (frame) => frames.push(frame),
        emptyState(),
        () => {},
        () => {},
      ),
    ).toBe("work");
    expect(frames).toHaveLength(1);
    const answer = fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5));
    expect(answer.message.case).toBe("kvClientMessage");
    const kv = answer.message.value as {
      message: { case: string; value: { blobData?: Uint8Array } };
    };
    expect(kv.message.case).toBe("getBlobResult");
    expect(Buffer.from(kv.message.value.blobData ?? [])).toEqual(Buffer.from(blobData));
  });

  it("does not answer a missing blob with an empty getBlobResult", () => {
    const frames: Uint8Array[] = [];

    expect(() =>
      processServerMessage(
        getBlobMessage(new Uint8Array([0xe3, 0x49, 0xbe, 0xb7])),
        new Map(),
        [],
        (frame) => frames.push(frame),
        emptyState(),
        () => {},
        () => {},
      ),
    ).toThrow(/blob/i);
    expect(frames).toHaveLength(0);
  });

  it("drops the stored checkpoint when the live blob store is a clone", () => {
    const original = new Map<string, Uint8Array>([["aa", new Uint8Array([1])]]);
    const stored: StoredConversation = {
      conversationId: "conv-1",
      checkpoint: new Uint8Array([9, 9, 9]),
      checkpointSource: "upstream",
      checkpointTurnCount: 3,
      sessionScoped: true,
      blobStore: original,
      lastAccessMs: Date.now(),
    };
    conversationStates.set("conv-key", stored);
    // request-build.ts clones stored.blobStore; the live stream does not share that Map.
    const live = new Map(original);
    const frames: Uint8Array[] = [];

    expect(() =>
      processServerMessage(
        getBlobMessage(new Uint8Array([0xe3, 0x49])),
        live,
        [],
        (frame) => frames.push(frame),
        emptyState(),
        () => {},
        () => {},
        undefined,
        undefined,
        undefined,
        "conv-key",
      ),
    ).toThrow(/blob/i);
    expect(frames).toHaveLength(0);
    expect(stored.checkpoint).toBeNull();
    expect(stored.conversationId).not.toBe("conv-1");
  });
});
