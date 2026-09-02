/**
 * Failures that used to be permanent: state that, once bad, broke every later turn of a
 * conversation rather than just the turn that produced it.
 */
import { describe, expect, it } from "bun:test";
import { parseMessages } from "../src/stream/message-parsing.js";
import {
  commitStoredCheckpoint,
  discardStaleCheckpointIfNeeded,
  fingerprintCompletedTurns,
  mergeBlobStore,
  trimBlobStore,
} from "../src/stream/session-state.js";
import { MAX_ACTIVE_BLOB_ENTRIES } from "../src/stream/tuning.js";
import type { OpenAIMessage, ParsedTurn, StoredConversation } from "../src/stream/types.js";

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
    });

    discardStaleCheckpointIfNeeded(stored, [], "r1", "c1");

    expect(stored.checkpoint).toBeNull();
  });

  it("discards a checkpoint that has grown past the transport frame limit", () => {
    // Regression: an unbounded checkpoint that outgrows the Connect transport's 64 MiB frame
    // cap used to fail every future turn permanently (frameConnectMessage throws before send).
    const stored = storedConversation({
      checkpoint: new Uint8Array(49 * 1024 * 1024),
      checkpointTurnCount: 0,
      checkpointHistoryFingerprint: "whatever",
    });

    discardStaleCheckpointIfNeeded(stored, [], "r1", "c1");

    expect(stored.checkpoint).toBeNull();
  });

  it("preserves a valid checkpoint when mid-pause metadata covers the tool-continuation off-by-one", () => {
    // Reproduces the stale_checkpoint error. A turn completes and commitStoredCheckpoint
    // writes checkpointTurnCount = completedTurns.length + 1 (it includes currentTurn).
    // On the next tool-result request, turns.length is still the pre-tool count.
    // The checkpoint should NOT be discarded if midPause metadata matches.
    const completedTurns = [
      { userText: "turn 1", steps: [] },
      { userText: "turn 2", steps: [] },
    ];
    const fp = fingerprintCompletedTurns(completedTurns);
    const validCheckpoint = new Uint8Array([0x0a, 0x00]); // minimal decodable protobuf

    const stored = storedConversation({
      checkpoint: validCheckpoint,
      checkpointTurnCount: completedTurns.length + 1, // as written by commitStoredCheckpoint
      checkpointHistoryFingerprint: "any-fingerprint", // from the complete turn, not current
      midPausePendingToolCalls: [{ toolCallId: "t1", toolName: "read" }],
      midPauseTurnCount: completedTurns.length,
      midPauseHistoryFingerprint: fp,
      midPauseRecordedAtMs: Date.now(),
    });

    discardStaleCheckpointIfNeeded(stored, completedTurns, "r1", "c1");

    // Checkpoint must survive so planRecovery can use it.
    expect(stored.checkpoint).not.toBeNull();
    expect(stored.midPausePendingToolCalls).toBeDefined();
  });

  it("rotates conversation identity when Pi history no longer matches the checkpoint", () => {
    const stored = storedConversation({
      conversationId: "old-id",
      checkpoint: new Uint8Array([0x0a, 0x00]),
      checkpointTurnCount: 5,
      checkpointHistoryFingerprint: "old-fp",
    });

    discardStaleCheckpointIfNeeded(stored, [{ userText: "only one", steps: [] }], "r1", "c1");

    expect(stored.checkpoint).toBeNull();
    expect(stored.conversationId).not.toBe("old-id");
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

  it("evicts oldest entries to stay inside the entry bound", () => {
    const store = new Map<string, Uint8Array>();
    for (let i = 0; i < 5; i++) store.set(`b${i}`, new Uint8Array([i]));
    const trimmed = trimBlobStore(store, 1024, 3);
    expect(trimmed.removed).toBe(2);
    expect(store.size).toBe(3);
    expect(store.has("b0")).toBe(false);
    expect(store.has("b1")).toBe(false);
    expect(store.has("b4")).toBe(true);
  });
});

/**
 * Restoring from the journal already refuses to pair a checkpoint with an incomplete blob set
 * (`journal.checkpoint_dropped_incomplete_blobs`), because Cursor answers a missing blob with an
 * empty result and the turn comes back blank rather than failing. Committing a checkpoint has to
 * hold the same line: the entry bound evicts oldest-first on a conversation that outgrows it, and
 * keeping the checkpoint anyway hands Cursor references we can no longer serve.
 */
describe("checkpoint durability across blob eviction", () => {
  const turn: ParsedTurn = { userText: "do the thing", steps: [] };

  it("drops a checkpoint whose blobs the entry bound just evicted", () => {
    const stored = storedConversation();
    const blobStore = new Map<string, Uint8Array>();
    for (let i = 0; i <= MAX_ACTIVE_BLOB_ENTRIES; i++) {
      blobStore.set(`blob-${i}`, new Uint8Array(8).fill(i % 256));
    }

    commitStoredCheckpoint(stored, new Uint8Array([1, 2, 3, 4]), blobStore, [], turn);

    expect(stored.blobStore.size).toBe(MAX_ACTIVE_BLOB_ENTRIES);
    expect(stored.blobStore.has("blob-0")).toBe(false);
    expect(stored.checkpoint).toBeNull();
    expect(stored.checkpointTurnCount).toBeUndefined();
    expect(stored.checkpointHistoryFingerprint).toBeUndefined();
  });

  it("keeps the checkpoint when the whole blob set survived", () => {
    const stored = storedConversation();
    const checkpoint = new Uint8Array([1, 2, 3, 4]);

    commitStoredCheckpoint(stored, checkpoint, new Map([["blob-0", new Uint8Array(8)]]), [], turn);

    expect(stored.checkpoint).toBe(checkpoint);
    expect(stored.checkpointTurnCount).toBe(1);
  });

  it("drops an earlier checkpoint when a merge that writes no checkpoint evicts blobs", () => {
    const stored = storedConversation({
      checkpoint: new Uint8Array([9, 9, 9, 9]),
      checkpointSource: "upstream",
      checkpointTurnCount: 3,
      checkpointHistoryFingerprint: "fp-3",
    });
    const blobStore = new Map<string, Uint8Array>();
    for (let i = 0; i <= MAX_ACTIVE_BLOB_ENTRIES; i++) {
      blobStore.set(`blob-${i}`, new Uint8Array(8).fill(i % 256));
    }

    const { evicted } = mergeBlobStore(stored, blobStore);

    expect(evicted).toBeGreaterThan(0);
    expect(stored.checkpoint).toBeNull();
    expect(stored.checkpointSource).toBeUndefined();
    expect(stored.checkpointTurnCount).toBeUndefined();
    expect(stored.checkpointHistoryFingerprint).toBeUndefined();
  });

  it("leaves an earlier checkpoint alone when a merge evicts nothing", () => {
    const checkpoint = new Uint8Array([9, 9, 9, 9]);
    const stored = storedConversation({
      checkpoint,
      checkpointSource: "upstream",
      checkpointTurnCount: 3,
      checkpointHistoryFingerprint: "fp-3",
    });

    const { evicted } = mergeBlobStore(stored, new Map([["blob-0", new Uint8Array(8)]]));

    expect(evicted).toBe(0);
    expect(stored.checkpoint).toBe(checkpoint);
    expect(stored.checkpointTurnCount).toBe(3);
  });
});
