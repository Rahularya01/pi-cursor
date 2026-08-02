import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canBlindIdleRestart,
  canRecoverAfterTransportLoss,
  resolveH2IdleTimeoutMs,
  resolveStreamIdleMaxRetries,
  resolveStreamIdleTimeoutMs,
} from "../src/stream/tuning.js";
import {
  CHECKPOINT_CONTINUATION_PROMPT,
  classifyBridgeExit,
  formatTransportFailure,
} from "../src/stream/transport-errors.js";
import {
  deserializeConversationJournal,
  readConversationJournal,
  serializeConversationJournal,
  writeConversationJournal,
  __testInternals as journalInternals,
} from "../src/stream/run-journal.js";
import { resetCacheDirForTests } from "../src/utils/cache-dir.js";
import type { StoredConversation } from "../src/stream/types.js";

describe("transport loss recovery policy", () => {
  it("allows blind restart only when nothing was streamed", () => {
    expect(canBlindIdleRestart(false)).toBe(true);
    expect(canBlindIdleRestart(true)).toBe(false);
  });

  it("allows checkpoint continuation after partial output", () => {
    expect(
      canRecoverAfterTransportLoss({
        emittedUserVisibleContent: true,
        hasCheckpoint: true,
      }),
    ).toBe(true);
    expect(
      canRecoverAfterTransportLoss({
        emittedUserVisibleContent: true,
        hasCheckpoint: false,
      }),
    ).toBe(false);
    expect(
      canRecoverAfterTransportLoss({
        emittedUserVisibleContent: false,
        hasCheckpoint: false,
      }),
    ).toBe(true);
  });
});

describe("transport failure classification", () => {
  it("treats GOAWAY / exit 2 as retryable", () => {
    const failure = classifyBridgeExit({ exitCode: 2, stderr: "GOAWAY errorCode=0" });
    expect(failure.kind).toBe("goaway");
    expect(failure.retryable).toBe(true);
    expect(formatTransportFailure(failure)).toMatch(/GOAWAY/i);
  });

  it("classifies auth failures as refreshable", () => {
    const failure = classifyBridgeExit({
      exitCode: 1,
      stderr: "Cursor HTTP 401: unauthorized token expired",
    });
    expect(failure.kind).toBe("authentication");
    expect(failure.retryable).toBe(true);
    expect(failure.refreshAuth).toBe(true);
  });

  it("classifies generic bridge crashes as retryable", () => {
    const failure = classifyBridgeExit({
      exitCode: 1,
      stderr: "stream error: ECONNRESET",
    });
    expect(failure.kind).toBe("connection_reset");
    expect(failure.retryable).toBe(true);
  });

  it("exposes a stable continuation prompt", () => {
    expect(CHECKPOINT_CONTINUATION_PROMPT).toMatch(/interrupted/i);
  });
});

describe("timeout defaults", () => {
  it("uses a longer silence window and more retries by default", () => {
    expect(resolveStreamIdleTimeoutMs(undefined)).toBe(180_000);
    expect(resolveStreamIdleMaxRetries(undefined)).toBe(5);
  });

  it("disables H2 activity idle by default so heartbeats own liveness", () => {
    expect(resolveH2IdleTimeoutMs(undefined)).toBe(0);
    expect(resolveH2IdleTimeoutMs("0")).toBe(0);
    expect(resolveH2IdleTimeoutMs("60000")).toBe(60_000);
  });
});

describe("durable run journal", () => {
  let dir: string | undefined;

  afterEach(() => {
    resetCacheDirForTests();
    delete process.env.PI_CURSOR_CACHE_DIR;
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      dir = undefined;
    }
  });

  function stored(): StoredConversation {
    return {
      conversationId: "conv-journal-1",
      checkpoint: new Uint8Array([1, 2, 3, 4]),
      checkpointSource: "upstream",
      checkpointTurnCount: 2,
      checkpointHistoryFingerprint: "fp-abc",
      midPausePendingToolCalls: [{ toolCallId: "t1", toolName: "read" }],
      midPauseTurnCount: 1,
      midPauseHistoryFingerprint: "fp-mid",
      midPauseRecordedAtMs: Date.now(),
      sessionScoped: true,
      sessionId: "session-1",
      blobStore: new Map([["blob-a", new Uint8Array([9, 8, 7])]]),
      lastAccessMs: Date.now(),
    };
  }

  it("round-trips conversation recovery state", () => {
    const record = serializeConversationJournal("conv-key-1", stored());
    expect(record.version).toBe(journalInternals.JOURNAL_VERSION);
    expect(record.checkpoint).toBeTruthy();
    expect(record.midPausePendingToolCalls?.[0]?.toolCallId).toBe("t1");

    const restored = deserializeConversationJournal(record);
    expect(restored).toBeTruthy();
    expect(restored!.conversationId).toBe("conv-journal-1");
    expect(Array.from(restored!.checkpoint ?? [])).toEqual([1, 2, 3, 4]);
    expect(Array.from(restored!.blobStore.get("blob-a") ?? [])).toEqual([9, 8, 7]);
    expect(restored!.midPausePendingToolCalls).toEqual([{ toolCallId: "t1", toolName: "read" }]);
  });

  it("persists and reloads from disk", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-cursor-journal-"));
    process.env.PI_CURSOR_CACHE_DIR = dir;
    resetCacheDirForTests();

    const ok = writeConversationJournal("ck-disk-1", stored());
    expect(ok).toBe(true);

    const loaded = readConversationJournal("ck-disk-1");
    expect(loaded).toBeTruthy();
    expect(loaded!.conversationId).toBe("conv-journal-1");
    expect(loaded!.sessionId).toBe("session-1");
    expect(Array.from(loaded!.checkpoint ?? [])).toEqual([1, 2, 3, 4]);
  });
});
