/**
 * Failures that used to be permanent: state that, once bad, broke every later turn of a
 * conversation rather than just the turn that produced it.
 */
import { describe, expect, it } from "vitest";
import { parseMessages } from "../src/stream/message-parsing.js";
import {
  discardStaleCheckpointIfNeeded,
  mergeBlobStore,
  trimBlobStore,
} from "../src/stream/session-state.js";
import type { OpenAIMessage, StoredConversation } from "../src/stream/types.js";

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngDataUrl(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  bytes.set(PNG_HEADER);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function storedConversation(partial: Partial<StoredConversation> = {}): StoredConversation {
  return {
    conversationId: "conv-1",
    checkpoint: null,
    sessionScoped: false,
    blobStore: new Map(),
    lastAccessMs: Date.now(),
    ...partial,
  };
}

describe("oversized images in history", () => {
  const oversized = pngDataUrl(6 * 1024 * 1024);

  it("does not fail a turn because an older turn carried an unusable image", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: { url: oversized } },
        ],
      },
      { role: "assistant", content: "noted" },
      { role: "user", content: "now do the next thing" },
    ] as OpenAIMessage[];

    const parsed = parseMessages(messages);

    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]!.userImages ?? []).toHaveLength(0);
    expect(parsed.userText).toBe("now do the next thing");
  });

  it("still rejects an unusable image on the turn being sent", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: { url: oversized } },
        ],
      },
    ] as OpenAIMessage[];

    expect(() => parseMessages(messages)).toThrow(/exceeds Cursor CLI/);
  });
});

describe("checkpoint durability", () => {
  it("discards an undecodable checkpoint instead of replaying it forever", () => {
    const stored = storedConversation({
      checkpoint: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      checkpointTurnCount: 0,
      checkpointHistoryFingerprint: "whatever",
      midPausePendingToolCalls: [{ toolCallId: "t1", toolName: "read" }],
      midPauseTurnCount: 0,
      midPauseHistoryFingerprint: "fp",
      midPauseRecordedAtMs: Date.now(),
      blobStore: new Map([["b1", new Uint8Array([1])]]),
    });

    discardStaleCheckpointIfNeeded(stored, [], "r1", "c1");

    expect(stored.checkpoint).toBeNull();
    // Rebuild fallback needs these; wiping them caused skipReason=stale_checkpoint.
    expect(stored.midPausePendingToolCalls).toEqual([{ toolCallId: "t1", toolName: "read" }]);
    expect(stored.blobStore.has("b1")).toBe(true);
  });
});

describe("blob store eviction order", () => {
  it("keeps blobs that every build re-references instead of evicting them first", () => {
    const stored = storedConversation();
    const systemBlob = new Uint8Array(40).fill(1);
    // Written first on every build and pointed at by every checkpoint.
    mergeBlobStore(stored, new Map([["system", systemBlob]]));
    mergeBlobStore(stored, new Map([["turn-1", new Uint8Array(40).fill(2)]]));
    // A later build re-references the system blob; it must not stay the oldest entry.
    mergeBlobStore(stored, new Map([["system", systemBlob]]));

    trimBlobStore(stored.blobStore, 60);

    expect(stored.blobStore.has("system")).toBe(true);
    expect(stored.blobStore.has("turn-1")).toBe(false);
  });
});
