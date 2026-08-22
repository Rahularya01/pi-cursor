import { afterEach, describe, expect, it } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  type InteractionUpdate,
} from "../src/proto/agent_pb.js";
import { frameConnectMessage, MAX_CONNECT_MESSAGE_BYTES } from "../src/client/bridge.js";
import { __testInternals } from "../src/stream/native-core.js";
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
import {
  cleanupSessionState,
  conversationStates,
  deriveConversationKeyFromSessionId,
} from "../src/stream/session-state.js";
import {
  parkIdleBridge,
  setBridgeFactoryForTests,
  startBridge,
  destroyAllIdleBridges,
} from "../src/stream/bridge-session.js";

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
    expect(statSync(join(dir, "run-journal")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "run-journal", "ck-disk-1.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects oversized journal files before reading them", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-cursor-journal-"));
    process.env.PI_CURSOR_CACHE_DIR = dir;
    resetCacheDirForTests();
    const journalDir = join(dir, "run-journal");
    mkdirSync(journalDir, { mode: 0o700 });
    const journalPath = join(journalDir, "oversized.json");
    writeFileSync(journalPath, "");
    truncateSync(journalPath, journalInternals.MAX_JOURNAL_FILE_BYTES + 1);

    expect(readConversationJournal("oversized")).toBeUndefined();
  });

  it("keeps the journal when a session is switched away", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-cursor-journal-"));
    process.env.PI_CURSOR_CACHE_DIR = dir;
    resetCacheDirForTests();

    const sessionId = "session-keep-journal";
    const convKey = deriveConversationKeyFromSessionId(sessionId);
    const snap = stored();
    snap.sessionId = sessionId;
    expect(writeConversationJournal(convKey, snap)).toBe(true);
    conversationStates.set(convKey, snap);

    cleanupSessionState(sessionId);

    expect(conversationStates.has(convKey)).toBe(false);
    const loaded = readConversationJournal(convKey);
    expect(loaded?.conversationId).toBe("conv-journal-1");
  });
});

describe("native stream terminal cleanup", () => {
  function setup(signal?: AbortSignal) {
    const calls: string[] = [];
    let endCalls = 0;
    let killCalls = 0;
    let onData: (chunk: Buffer) => void = () => {};
    let onClose: (code: number) => void = () => {};
    const bridge = {
      proc: {
        kill: () => {
          killCalls++;
          return true;
        },
      },
      alive: true,
      lastStderr: () => "",
      write: () => {},
      end: () => {
        endCalls++;
      },
      onData: (cb: (chunk: Buffer) => void) => {
        onData = cb;
      },
      onClose: (cb: (code: number) => void) => {
        onClose = cb;
      },
    };
    const writer = {
      output: {} as never,
      closed: false,
      start() {},
      text() {},
      thinking() {},
      toolCall() {},
      done(reason: string) {
        calls.push(`done:${reason}`);
        this.closed = true;
      },
      error(message: string) {
        calls.push(`error:${message}`);
        this.closed = true;
      },
    };
    const heartbeatTimer = setInterval(() => {}, 60_000);
    __testInternals.writeNativeStream(
      bridge,
      heartbeatTimer,
      new Map(),
      [],
      {} as never,
      "claude-4.5-sonnet",
      "bridge-cleanup",
      "conv-cleanup",
      [],
      { userText: "hi", steps: [] },
      writer as never,
      signal ? ({ signal } as never) : undefined,
      "req-cleanup",
      undefined,
      0,
    );
    return {
      calls,
      get endCalls() {
        return endCalls;
      },
      get killCalls() {
        return killCalls;
      },
      onData,
      onClose,
      heartbeatTimer,
    };
  }

  it("honors a signal that was aborted before the stream starts", () => {
    const controller = new AbortController();
    controller.abort();
    const harness = setup(controller.signal);
    clearInterval(harness.heartbeatTimer);
    expect(harness.calls).toEqual(["error:Aborted"]);
    expect(harness.endCalls).toBe(1);
  });

  it("terminates the bridge when a server frame cannot be decoded", () => {
    const harness = setup();
    const malformed = Buffer.from([0, 0, 0, 0, 1, 0xff]);
    harness.onData(malformed);
    clearInterval(harness.heartbeatTimer);
    expect(harness.calls[0]).toMatch(/^error:/);
    expect(harness.endCalls).toBe(1);
  });

  it("contains an oversized frame declaration without terminating the host process", () => {
    const harness = setup();
    const oversized = Buffer.alloc(5);
    oversized.writeUInt32BE(MAX_CONNECT_MESSAGE_BYTES + 1, 1);

    // A corrupted/misaligned frame boundary is local per-connection state, not a permanent
    // failure — it must not crash the host process, and it must not fail the turn outright
    // either. Killing the bridge routes it through the same retry path as any other transport
    // loss (GOAWAY, ECONNRESET, ...), so a fresh connection can continue the turn.
    expect(() => harness.onData(oversized)).not.toThrow();
    expect(harness.killCalls).toBe(1);
    expect(harness.calls).toEqual([]);

    // Simulate the process actually exiting after the kill, as a real bridge would.
    harness.onClose(1);
    clearInterval(harness.heartbeatTimer);
    expect(harness.calls[0]).toMatch(/^error:/);
    expect(harness.endCalls).toBe(0);
  });
});

describe("completed-turn connection close", () => {
  function frame(bytes: Uint8Array, flags = 0): Buffer {
    return frameConnectMessage(bytes, flags);
  }

  function updateFrame(message: InteractionUpdate["message"]): Buffer {
    return frame(
      toBinary(
        AgentServerMessageSchema,
        create(AgentServerMessageSchema, {
          message: {
            case: "interactionUpdate",
            value: create(InteractionUpdateSchema, { message }),
          },
        }),
      ),
    );
  }

  it("finalizes the turn when Cursor GOAWAYs after turnEnded (upstream #3)", () => {
    const calls: string[] = [];
    const writer = {
      output: {} as never,
      closed: false,
      start() {},
      text() {},
      thinking() {},
      toolCall() {},
      done(reason: string) {
        calls.push(`done:${reason}`);
        this.closed = true;
      },
      error(message: string) {
        calls.push(`error:${message}`);
        this.closed = true;
      },
    };
    let onData: (chunk: Buffer) => void = () => {};
    let onClose: (code: number) => void = () => {};
    const bridge = {
      proc: { kill: () => true },
      alive: true,
      lastStderr: () => "GOAWAY errorCode=0",
      write: () => {},
      end: () => {},
      onData: (cb: (chunk: Buffer) => void) => {
        onData = cb;
      },
      onClose: (cb: (code: number) => void) => {
        onClose = cb;
      },
    };
    const heartbeatTimer = setInterval(() => {}, 60_000);

    __testInternals.writeNativeStream(
      bridge,
      heartbeatTimer,
      new Map(),
      [],
      {} as never,
      "claude-4.5-sonnet",
      "bridge-key",
      "conv-key",
      [],
      { userText: "hi", steps: [] },
      writer as never,
      undefined,
      "req-1",
      undefined,
      0,
    );

    onData(
      updateFrame({
        case: "textDelta",
        value: create(TextDeltaUpdateSchema, { text: "hello" }),
      }),
    );
    onData(updateFrame({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) }));
    // Cursor's GOAWAY arrives as a Connect end-stream error, then the bridge exits 2.
    onData(
      frame(
        new TextEncoder().encode(
          JSON.stringify({
            error: {
              code: "unavailable",
              message: "Cursor GOAWAY (errorCode=0): upstream connection closed, retriable",
            },
          }),
        ),
        2,
      ),
    );
    onClose(2);
    clearInterval(heartbeatTimer);

    expect(calls).toEqual(["done:stop"]);
  });
});

describe("idle HTTP/2 bridge reuse", () => {
  afterEach(() => {
    destroyAllIdleBridges();
    setBridgeFactoryForTests();
  });

  it("reopens a parked persistent bridge instead of spawning a new process", () => {
    const spawned: string[] = [];
    const opens: string[] = [];
    const handle = {
      proc: { kill: () => true },
      alive: true,
      lastStderr: () => "",
      write: () => {},
      end: () => {},
      onData: () => {},
      onClose: () => {},
      openStream: (token: string) => {
        opens.push(token);
      },
    };
    setBridgeFactoryForTests(() => {
      spawned.push("spawn");
      return handle;
    });

    parkIdleBridge("bk-reuse", handle);
    const started = startBridge("tok-2", new Uint8Array([1, 2, 3]), { bridgeKey: "bk-reuse" });
    clearInterval(started.heartbeatTimer);

    expect(spawned).toEqual([]);
    expect(opens).toEqual(["tok-2"]);
    expect(started.bridge).toBe(handle);
  });
});
