import { afterEach, describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  McpArgsSchema,
  McpToolDefinitionSchema,
  PartialToolCallUpdateSchema,
  SetBlobArgsSchema,
  ToolCallStartedUpdateSchema,
} from "../src/proto/agent_pb.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import type { StreamState } from "../src/stream/types.js";
import {
  __testInternals,
  canBlindIdleRestart,
  interactionUpdateCountsAsProgress,
  resolveH2ConnectTimeoutMs,
  resolveH2IdleTimeoutMs,
  resolveResumeIdleTimeoutMs,
  resolveStreamIdleMaxRetries,
  resolveStreamIdleTimeoutMs,
} from "../src/stream/native-core.js";
import { MAX_ACTIVE_BLOB_ENTRIES } from "../src/stream/tuning.js";

afterEach(() => {
  __testInternals.conversationStates.clear();
});

describe("idle progress classification", () => {
  it("rejects MCP executions for tools that were not advertised", () => {
    const message = create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: 1,
          execId: "exec-1",
          message: {
            case: "mcpArgs",
            value: create(McpArgsSchema, {
              toolCallId: "call-1",
              toolName: "unadvertised_tool",
            }),
          },
        }),
      },
    });
    const advertised = [
      create(McpToolDefinitionSchema, {
        name: "allowed_tool",
        toolName: "allowed_tool",
      }),
    ];
    const frames: Uint8Array[] = [];
    const executions: unknown[] = [];
    const state: StreamState = {
      toolCallIndex: 0,
      pendingExecs: [],
      outputTokens: 0,
      totalTokens: 0,
      turnEnded: false,
    };

    expect(
      processServerMessage(
        message,
        new Map(),
        advertised,
        (frame) => frames.push(frame),
        state,
        () => {},
        (execution) => executions.push(execution),
      ),
    ).toBe(true);
    expect(frames).toHaveLength(1);
    expect(executions).toHaveLength(0);
  });

  it("evicts the oldest active blob instead of failing the write at the entry bound", () => {
    const store = new Map<string, Uint8Array>();
    for (let i = 0; i < MAX_ACTIVE_BLOB_ENTRIES; i++) {
      store.set(i.toString(16).padStart(4, "0"), new Uint8Array([1]));
    }
    const message = create(AgentServerMessageSchema, {
      message: {
        case: "kvServerMessage",
        value: create(KvServerMessageSchema, {
          message: {
            case: "setBlobArgs",
            value: create(SetBlobArgsSchema, {
              blobId: new Uint8Array([0xff, 0xff]),
              blobData: new Uint8Array([1]),
            }),
          },
        }),
      },
    });
    const state: StreamState = {
      toolCallIndex: 0,
      pendingExecs: [],
      outputTokens: 0,
      totalTokens: 0,
      turnEnded: false,
    };
    const frames: Uint8Array[] = [];
    expect(
      processServerMessage(
        message,
        store,
        [],
        (frame) => frames.push(frame),
        state,
        () => {},
        () => {},
      ),
    ).toBe(true);
    expect(frames).toHaveLength(1);
    expect(store.size).toBe(MAX_ACTIVE_BLOB_ENTRIES);
    expect(store.has("0000")).toBe(false);
    expect(store.has("ffff")).toBe(true);
  });

  it("treats tokenDelta and toolCallCompleted as watchdog progress", () => {
    expect(interactionUpdateCountsAsProgress("tokenDelta")).toBe(true);
    expect(interactionUpdateCountsAsProgress("toolCallCompleted")).toBe(true);
    expect(interactionUpdateCountsAsProgress("heartbeat")).toBe(true);
    expect(interactionUpdateCountsAsProgress("thinkingCompleted")).toBe(true);
    expect(interactionUpdateCountsAsProgress("toolCallStarted")).toBe(true);
  });

  it("resets the watchdog for liveness updates the dispatcher receives", () => {
    const liveness = [
      { case: "heartbeat" as const, value: create(HeartbeatUpdateSchema, {}) },
      { case: "toolCallStarted" as const, value: create(ToolCallStartedUpdateSchema, {}) },
      { case: "partialToolCall" as const, value: create(PartialToolCallUpdateSchema, {}) },
    ];
    for (const message of liveness) {
      const state: StreamState = {
        toolCallIndex: 0,
        pendingExecs: [],
        outputTokens: 0,
        totalTokens: 0,
        turnEnded: false,
      };
      const serverMessage = create(AgentServerMessageSchema, {
        message: {
          case: "interactionUpdate",
          value: create(InteractionUpdateSchema, { message }),
        },
      });
      const madeProgress = processServerMessage(
        serverMessage,
        new Map(),
        [],
        () => {},
        state,
        () => {},
        () => {},
      );
      expect([message.case, madeProgress]).toEqual([message.case, true]);
    }
  });

  it("requires non-empty text for text/thinking deltas", () => {
    expect(interactionUpdateCountsAsProgress("textDelta", true)).toBe(true);
    expect(interactionUpdateCountsAsProgress("textDelta", false)).toBe(false);
    expect(interactionUpdateCountsAsProgress("thinkingDelta", true)).toBe(true);
    expect(interactionUpdateCountsAsProgress("thinkingDelta", false)).toBe(false);
  });

  it("blocks blind restarts once user-visible content was streamed", () => {
    expect(canBlindIdleRestart(false)).toBe(true);
    expect(canBlindIdleRestart(true)).toBe(false);
  });
});

describe("idle timeout resolvers", () => {
  it("defaults stream/resume idle to a silence safety net; retries bounded", () => {
    expect(resolveStreamIdleTimeoutMs(undefined)).toBe(180_000);
    expect(resolveResumeIdleTimeoutMs(undefined)).toBe(180_000);
    expect(resolveStreamIdleMaxRetries(undefined)).toBe(5);
  });

  it("still allows disabling the idle watchdog explicitly with 0", () => {
    expect(resolveStreamIdleTimeoutMs("0")).toBe(0);
    expect(resolveResumeIdleTimeoutMs("0")).toBe(0);
    expect(resolveStreamIdleMaxRetries("0")).toBe(0);
  });

  it("defaults h2 activity idle to disabled; connect timeout stays 30s", () => {
    expect(resolveH2ConnectTimeoutMs(undefined)).toBe(30_000);
    // Disabled by default; parent heartbeats own liveness. Opt in via env.
    expect(resolveH2IdleTimeoutMs(undefined)).toBe(0);
  });

  it("parses env overrides and rejects invalid values", () => {
    expect(resolveStreamIdleTimeoutMs("90000")).toBe(90_000);
    expect(resolveStreamIdleTimeoutMs("0")).toBe(0);
    expect(resolveStreamIdleTimeoutMs("nope")).toBe(180_000);
    expect(resolveStreamIdleMaxRetries("0")).toBe(0);
    expect(resolveStreamIdleMaxRetries("99")).toBe(10);
    expect(resolveH2IdleTimeoutMs("60000")).toBe(60_000);
    expect(resolveH2IdleTimeoutMs("0")).toBe(0);
  });
});

describe("disabled idle watchdog", () => {
  it("never fires when timeoutMs is 0", async () => {
    let fired = 0;
    const watchdog = __testInternals.createStreamIdleWatchdog({
      timeoutMs: 0,
      onTimeout: () => {
        fired += 1;
      },
    });
    watchdog.start();
    watchdog.reset();
    await new Promise((resolve) => setTimeout(resolve, 40));
    watchdog.clear();
    expect(fired).toBe(0);
  });
});

describe("stream idle watchdog", () => {
  it("fires after the configured timeout when never reset", async () => {
    let fired = 0;
    const watchdog = __testInternals.createStreamIdleWatchdog({
      timeoutMs: 30,
      onTimeout: () => {
        fired += 1;
      },
    });
    watchdog.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    watchdog.clear();
    expect(fired).toBe(1);
  });

  it("does not fire while progress keeps resetting it", async () => {
    let fired = 0;
    const watchdog = __testInternals.createStreamIdleWatchdog({
      timeoutMs: 50,
      onTimeout: () => {
        fired += 1;
      },
    });
    watchdog.start();
    const interval = setInterval(() => watchdog.reset(), 15);
    await new Promise((resolve) => setTimeout(resolve, 120));
    clearInterval(interval);
    watchdog.clear();
    expect(fired).toBe(0);
  });
});

describe("blob store trim", () => {
  it("drops oldest blobs when the soft cap is exceeded", () => {
    const store = new Map<string, Uint8Array>();
    store.set("old", new Uint8Array(100));
    store.set("mid", new Uint8Array(100));
    store.set("new", new Uint8Array(50));
    const result = __testInternals.trimBlobStore(store, 120);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.totalBytes).toBeLessThanOrEqual(120);
    expect(store.has("new")).toBe(true);
  });
});
