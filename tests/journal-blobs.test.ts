/**
 * A checkpoint addresses its history by blob id, so a journal that cannot carry
 * the whole blob store restores a conversation whose older turns resolve to
 * nothing — with no error anywhere. These pin the two halves of that fix:
 * persist everything the live store is allowed to hold, and refuse to resume
 * from a checkpoint whose blobs did not survive.
 */
import { describe, expect, it } from "vitest";
import { __testInternals } from "../src/stream/run-journal.js";
import { MAX_ACTIVE_BLOB_ENTRIES } from "../src/stream/tuning.js";
import type { StoredConversation } from "../src/stream/types.js";

const { serializeConversationJournal, deserializeConversationJournal } = __testInternals;

function stored(blobStore: Map<string, Uint8Array>, checkpoint: Uint8Array | null = null) {
  return {
    conversationId: "conv-1",
    checkpoint,
    ...(checkpoint ? { checkpointSource: "upstream" as const, checkpointTurnCount: 4 } : {}),
    sessionScoped: true,
    sessionId: "s1",
    blobStore,
    lastAccessMs: Date.now(),
  } satisfies StoredConversation;
}

function blobs(count: number, bytesEach = 8): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) map.set(`blob${i}`, new Uint8Array(bytesEach).fill(i % 256));
  return map;
}

describe("journal blob persistence", () => {
  it("round-trips a store far larger than the old 64-entry cap", () => {
    const store = blobs(300);
    const record = serializeConversationJournal("k", stored(store, new Uint8Array([1, 2, 3])));

    expect(record.blobs).toHaveLength(300);
    expect(record.blobsOmitted).toBeUndefined();

    const restored = deserializeConversationJournal(record)!;
    expect(restored.blobStore.size).toBe(300);
    // The oldest blob is the one the old newest-64 window dropped first, and it
    // is exactly the system-prompt/early-turn content a checkpoint points at.
    expect(restored.blobStore.get("blob0")).toEqual(store.get("blob0"));
    expect(restored.blobStore.get("blob299")).toEqual(store.get("blob299"));
  });

  it("keeps the checkpoint when every blob survives", () => {
    const record = serializeConversationJournal("k", stored(blobs(200), new Uint8Array([9])));
    const restored = deserializeConversationJournal(record)!;

    expect(restored.checkpoint).toEqual(new Uint8Array([9]));
    expect(restored.checkpointSource).toBe("upstream");
    expect(restored.checkpointTurnCount).toBe(4);
  });

  it("never persists more blobs than the live store is allowed to hold", () => {
    const record = serializeConversationJournal("k", stored(blobs(MAX_ACTIVE_BLOB_ENTRIES + 50)));
    expect(record.blobs.length).toBeLessThanOrEqual(MAX_ACTIVE_BLOB_ENTRIES);
    expect(record.blobsOmitted).toBeGreaterThan(0);
  });

  it("drops the checkpoint rather than resuming with blank history", () => {
    const record = serializeConversationJournal("k", stored(blobs(4), new Uint8Array([9])));
    // Simulate a record whose blobs did not all fit.
    const truncated = { ...record, blobsOmitted: 12 };

    const restored = deserializeConversationJournal(truncated)!;
    expect(restored.checkpoint).toBeNull();
    expect(restored.checkpointSource).toBeUndefined();
    expect(restored.checkpointTurnCount).toBeUndefined();
    // The blobs that did survive are still useful for the rebuild path.
    expect(restored.blobStore.size).toBe(4);
  });

  it("treats a corrupt blob entry as a missing one", () => {
    const record = serializeConversationJournal("k", stored(blobs(3), new Uint8Array([9])));
    const corrupted = {
      ...record,
      blobs: [...record.blobs.slice(0, 2), { id: "", data: "!!!" }],
    } as typeof record;

    const restored = deserializeConversationJournal(corrupted)!;
    expect(restored.checkpoint).toBeNull();
    expect(restored.blobStore.size).toBe(2);
  });

  it("leaves a checkpoint-free record alone when blobs are incomplete", () => {
    const record = serializeConversationJournal("k", stored(blobs(3)));
    const restored = deserializeConversationJournal({ ...record, blobsOmitted: 5 })!;

    expect(restored.checkpoint).toBeNull();
    expect(restored.blobStore.size).toBe(3);
    expect(restored.conversationId).toBe("conv-1");
  });

  it("preserves mid-pause metadata across a checkpoint drop", () => {
    const base = serializeConversationJournal("k", stored(blobs(2), new Uint8Array([9])));
    const record = {
      ...base,
      blobsOmitted: 3,
      midPausePendingToolCalls: [{ toolCallId: "c1", toolName: "shell" }],
      midPauseTurnCount: 2,
    };

    const restored = deserializeConversationJournal(record)!;
    expect(restored.checkpoint).toBeNull();
    expect(restored.midPausePendingToolCalls).toEqual([{ toolCallId: "c1", toolName: "shell" }]);
    expect(restored.midPauseTurnCount).toBe(2);
  });
});
