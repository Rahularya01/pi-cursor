import { afterEach, describe, expect, it } from "vitest";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
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
  type ExecClientControlMessage,
  type ExecClientThrow,
} from "../src/proto/agent_pb.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import type { StreamState } from "../src/stream/types.js";
import {
  __testInternals,
  canBlindIdleRestart,
  interactionUpdateProgress,
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
    ).toBe("work");
    expect(frames).toHaveLength(1);
    expect(executions).toHaveLength(0);
  });

  it("answers an exec case it cannot decode with a throw instead of parking", () => {
    const message = create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, { id: 7, execId: "exec-7" }),
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
    const parked: (string | undefined)[] = [];

    const progress = processServerMessage(
      message,
      new Map(),
      [],
      (frame) => frames.push(frame),
      state,
      () => {},
      () => {},
      undefined,
      (execCase) => parked.push(execCase),
    );

    expect(progress).toBe("none");
    expect(parked).toHaveLength(1);
    expect(frames).toHaveLength(1);
    const answer = fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5));
    expect(answer.message.case).toBe("execClientControlMessage");
    const control = answer.message.value as ExecClientControlMessage;
    expect(control.message.case).toBe("throw");
    expect((control.message.value as ExecClientThrow).id).toBe(7);
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
    ).toBe("work");
    expect(frames).toHaveLength(1);
    expect(store.size).toBe(MAX_ACTIVE_BLOB_ENTRIES);
    expect(store.has("0000")).toBe(false);
    expect(store.has("ffff")).toBe(true);
  });

  it("separates real work from a heartbeat that only proves the socket", () => {
    expect(interactionUpdateProgress("tokenDelta")).toBe("work");
    expect(interactionUpdateProgress("toolCallCompleted")).toBe("work");
    expect(interactionUpdateProgress("thinkingCompleted")).toBe("work");
    expect(interactionUpdateProgress("toolCallStarted")).toBe("work");
    expect(interactionUpdateProgress("heartbeat")).toBe("liveness");
  });

  it("classifies the liveness updates the dispatcher receives", () => {
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
      const progress = processServerMessage(
        serverMessage,
        new Map(),
        [],
        () => {},
        state,
        () => {},
        () => {},
      );
      expect([message.case, progress]).toEqual([
        message.case,
        message.case === "heartbeat" ? "liveness" : "work",
      ]);
    }
  });

  it("requires non-empty text for text/thinking deltas", () => {
    expect(interactionUpdateProgress("textDelta", true)).toBe("work");
    expect(interactionUpdateProgress("textDelta", false)).toBe("none");
    expect(interactionUpdateProgress("thinkingDelta", true)).toBe("work");
    expect(interactionUpdateProgress("thinkingDelta", false)).toBe("none");
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
  it("re-arms on a shorter deadline once a park shortens it", async () => {
    let fired = 0;
    const watchdog = __testInternals.createStreamIdleWatchdog({
      timeoutMs: 10_000,
      onTimeout: () => {
        fired += 1;
      },
    });
    watchdog.start();
    watchdog.setTimeoutMs(30);
    await new Promise((resolve) => setTimeout(resolve, 90));
    watchdog.clear();
    expect(fired).toBe(1);
  });

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
