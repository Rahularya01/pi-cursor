import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create, fromBinary, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  Tool,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeHandle } from "../src/client/bridge.js";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ExecServerMessageSchema,
  GetBlobArgsSchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  McpArgsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  type AgentClientMessage,
  type AgentRunRequest,
  type AgentServerMessage,
  type ExecClientMessage,
} from "../src/proto/agent_pb.js";
import {
  CHECKPOINT_CONTINUATION_PROMPT,
  cleanupAllSessionState,
  createCursorNativeStream,
  setBridgeFactoryForTests,
} from "../src/stream/native-core.js";
import { ConnectFlag } from "../src/types/enums.js";
import { resetCacheDirForTests } from "../src/utils/cache-dir.js";

const SYSTEM_PROMPT = "You are Pi, a coding agent working in this repository.";
const PROMPT = "Read README.md and summarize it.";
const README = "# pi-cursor\nNative Cursor provider for Pi.";
const TOOL_CALL_ID = "call-read-1";
const EXEC_ID = "exec-read-1";
const EXEC_MSG_ID = 7;
const CHECKPOINT_MARKER = "file:///checkpoint-marker";
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
// Captured before any test fakes timers, so the never-finished guard still fires.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const model = {
  id: "claude-4.5-sonnet",
  name: "Claude 4.5 Sonnet",
  api: "cursor-native",
  provider: "cursor",
} as unknown as Model<Api>;

const readTool = {
  name: "read",
  description: "Read a file from the workspace.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} as unknown as Tool;

type ServerMessage = AgentServerMessage["message"];

function connectFrame(payload: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

function serverFrame(message: ServerMessage): Buffer {
  return connectFrame(
    toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message })),
  );
}

function endStreamErrorFrame(code: string, message: string): Buffer {
  return connectFrame(
    Buffer.from(JSON.stringify({ error: { code, message } }), "utf8"),
    ConnectFlag.EndStream,
  );
}

function decodeClientFrame(frame: Buffer): AgentClientMessage {
  expect(frame.readUInt32BE(1), "client frame length prefix").toBe(frame.length - 5);
  return fromBinary(AgentClientMessageSchema, frame.subarray(5));
}

function mcpArg(value: JsonValue): Uint8Array {
  return toBinary(ValueSchema, fromJson(ValueSchema, value));
}

const cursor = {
  text: (text: string): ServerMessage => ({
    case: "interactionUpdate",
    value: create(InteractionUpdateSchema, {
      message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
    }),
  }),
  turnEnded: (): ServerMessage => ({
    case: "interactionUpdate",
    value: create(InteractionUpdateSchema, {
      message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
    }),
  }),
  readFile: (path: string): ServerMessage => ({
    case: "execServerMessage",
    value: create(ExecServerMessageSchema, {
      id: EXEC_MSG_ID,
      execId: EXEC_ID,
      message: {
        case: "mcpArgs",
        value: create(McpArgsSchema, {
          name: "pi-mcp_pi_read",
          toolName: "mcp_pi_read",
          providerIdentifier: "pi",
          toolCallId: TOOL_CALL_ID,
          args: { path: mcpArg(path) },
        }),
      },
    }),
  }),
  checkpoint: (): ServerMessage => ({
    case: "conversationCheckpointUpdate",
    value: create(ConversationStateStructureSchema, { readPaths: [CHECKPOINT_MARKER] }),
  }),
  getBlob: (id: number, blobId: Uint8Array): ServerMessage => ({
    case: "kvServerMessage",
    value: create(KvServerMessageSchema, {
      id,
      message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
    }),
  }),
};

/**
 * Scripted stand-in for the in-process HTTP/2 transport. It mirrors the exit-code contract
 * h2-session.ts documents: kill() closes with 1 synchronously, GOAWAY delivers a retriable
 * end-stream frame and then exits 2, a socket error exits 1 with a stderr diagnostic, and a
 * persistent stream that ends cleanly reports stream-done instead of closing.
 */
function createFakeBridge() {
  const frames: Buffer[] = [];
  let exited = false;
  let exitCode = 1;
  let stderr = "";
  let reopened = 0;
  let endedByClient = 0;
  let dataListener: ((chunk: Buffer) => void) | undefined;
  let closeListener: ((code: number) => void) | undefined;
  let streamDoneListener: (() => void) | undefined;

  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    closeListener?.(code);
  };
  const deliver = (chunk: Buffer) => {
    if (!dataListener) throw new Error("no stream is listening on this bridge");
    dataListener(chunk);
  };

  const handle: BridgeHandle = {
    proc: {
      kill: () => {
        exit(1);
        return true;
      },
    },
    get alive() {
      return !exited;
    },
    lastStderr: () => stderr,
    write: (data) => {
      if (!exited) frames.push(Buffer.from(data));
    },
    end: () => {
      endedByClient++;
      queueMicrotask(() => exit(0));
    },
    onData: (cb) => {
      dataListener = cb;
    },
    onClose: (cb) => {
      if (exited) queueMicrotask(() => cb(exitCode));
      else closeListener = cb;
    },
    openStream: () => {
      reopened++;
      dataListener = undefined;
      closeListener = undefined;
      streamDoneListener = undefined;
    },
    onStreamDone: (cb) => {
      streamDoneListener = cb;
    },
  };

  return {
    handle,
    get reopened() {
      return reopened;
    },
    get endedByClient() {
      return endedByClient;
    },
    received: () => frames.map(decodeClientFrame),
    send: (...messages: ServerMessage[]) => deliver(Buffer.concat(messages.map(serverFrame))),
    finishStream: () => streamDoneListener?.(),
    failStream: (code: string, message: string) => {
      deliver(endStreamErrorFrame(code, message));
      if (!exited) streamDoneListener?.();
    },
    goaway: () => {
      stderr = "[h2-session] GOAWAY errorCode=0 opaque=";
      deliver(
        endStreamErrorFrame(
          "unavailable",
          "Cursor GOAWAY (errorCode=0): upstream connection closed, retriable",
        ),
      );
      exit(2);
    },
    resetConnection: () => {
      stderr = "[h2-session] stream error: read ECONNRESET";
      exit(1);
    },
  };
}

type FakeBridge = ReturnType<typeof createFakeBridge>;

let cacheDir: string;
let bridges: FakeBridge[];
let tokenRequests: Array<{ forceRefresh?: boolean } | undefined>;
let sessionId: string;
let sessionCount = 0;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "pi-cursor-contract-"));
  process.env.PI_CURSOR_CACHE_DIR = cacheDir;
  process.env.PI_CURSOR_LIFECYCLE_LOG = join(cacheDir, "lifecycle.jsonl");
  delete process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES;
  delete process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS;
  resetCacheDirForTests();
  bridges = [];
  tokenRequests = [];
  sessionId = `contract-session-${++sessionCount}`;
  setBridgeFactoryForTests(() => {
    const bridge = createFakeBridge();
    bridges.push(bridge);
    return bridge.handle;
  });
});

afterEach(() => {
  cleanupAllSessionState();
  vi.useRealTimers();
  setBridgeFactoryForTests();
  delete process.env.PI_CURSOR_CACHE_DIR;
  delete process.env.PI_CURSOR_LIFECYCLE_LOG;
  delete process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES;
  resetCacheDirForTests();
  // The lifecycle log appends asynchronously and can land mid-removal (ENOTEMPTY).
  rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function user(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function readResult(text: string): Message {
  return {
    role: "toolResult",
    toolCallId: TOOL_CALL_ID,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function context(...messages: Message[]): Context {
  return { systemPrompt: SYSTEM_PROMPT, tools: [readTool], messages };
}

function streamPi(piContext: Context, signal?: AbortSignal): AssistantMessageEventStream {
  const streamSimple = createCursorNativeStream({
    getAccessToken: (options) => {
      tokenRequests.push(options);
      return Promise.resolve("cursor-token");
    },
  });
  return streamSimple(model, piContext, { sessionId, signal });
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await nextTick();
}

async function spawned(index: number): Promise<FakeBridge> {
  for (let i = 0; i < 20 && bridges.length <= index; i++) await nextTick();
  const bridge = bridges[index];
  if (!bridge) throw new Error(`bridge #${index + 1} was never spawned`);
  return bridge;
}

async function outcome(
  stream: AssistantMessageEventStream,
): Promise<{ message: AssistantMessage; events: string[] }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const message = await Promise.race([
    stream.result(),
    new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => reject(new Error("Pi's stream never finished")), 1_000);
    }),
  ]).finally(() => realClearTimeout(timer));
  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  return { message, events };
}

function textOf(message: AssistantMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function runRequests(bridge: FakeBridge): AgentRunRequest[] {
  return bridge
    .received()
    .flatMap((message) => (message.message.case === "runRequest" ? [message.message.value] : []));
}

function onlyRunRequest(bridge: FakeBridge): AgentRunRequest {
  const runs = runRequests(bridge);
  expect(runs, "one run request opens the stream").toHaveLength(1);
  return runs[0]!;
}

function userText(run: AgentRunRequest): string | undefined {
  const action = run.action?.action;
  return action?.case === "userMessageAction" ? action.value.userMessage?.text : undefined;
}

function lastAction(bridge: FakeBridge): string | undefined {
  const last = bridge.received().at(-1)?.message;
  return last?.case === "conversationAction" ? last.value.action.case : undefined;
}

function execReplies(bridge: FakeBridge): ExecClientMessage[] {
  return bridge
    .received()
    .flatMap((message) =>
      message.message.case === "execClientMessage" ? [message.message.value] : [],
    );
}

/** Cursor fetches every blob a run request points at; each fetch must come back with bytes. */
function expectReferencedBlobsServed(bridge: FakeBridge, run: AgentRunRequest): void {
  const state = run.conversationState;
  const ids = [...(state?.rootPromptMessagesJson ?? []), ...(state?.turns ?? [])];
  const before = bridge.received().length;
  bridge.send(...ids.map((blobId, index) => cursor.getBlob(index + 1, blobId)));
  const served = bridge
    .received()
    .slice(before)
    .flatMap((message) =>
      message.message.case === "kvClientMessage" &&
      message.message.value.message.case === "getBlobResult"
        ? [(message.message.value.message.value.blobData?.byteLength ?? 0) > 0]
        : [],
    );
  expect(served, "every referenced blob is served").toEqual(ids.map(() => true));
}

async function finishWithText(bridge: FakeBridge, stream: AssistantMessageEventStream) {
  bridge.send(cursor.text("README describes the Pi provider."), cursor.turnEnded());
  bridge.finishStream();
  return outcome(stream);
}

async function pauseOnReadTool(): Promise<{ bridge: FakeBridge; toolUse: AssistantMessage }> {
  const stream = streamPi(context(user(PROMPT)));
  const bridge = await spawned(0);
  bridge.send(cursor.readFile("README.md"));
  const { message } = await outcome(stream);
  expect(message.stopReason, "Pi receives the tool call").toBe("toolUse");
  return { bridge, toolUse: message };
}

function streamReadResult(toolUse: AssistantMessage): AssistantMessageEventStream {
  return streamPi(context(user(PROMPT), toolUse, readResult(README)));
}

describe("native stream contract: a turn Cursor completes", () => {
  it.each([
    ["the stream ends", (bridge: FakeBridge) => bridge.finishStream()],
    ["Cursor GOAWAYs after turnEnded", (bridge: FakeBridge) => bridge.goaway()],
  ])("streams text and finishes with stop when %s", async (_label, close) => {
    const stream = streamPi(context(user(PROMPT)));
    const bridge = await spawned(0);
    const run = onlyRunRequest(bridge);
    expect(userText(run), "Cursor receives the user's prompt").toBe(PROMPT);
    expect(
      run.mcpTools?.mcpTools.map((tool) => tool.name),
      "Pi's tools are offered to Cursor",
    ).toEqual(["read"]);
    expectReferencedBlobsServed(bridge, run);

    bridge.send(cursor.text("Hello"), cursor.text(" world"));
    bridge.send(cursor.turnEnded());
    close(bridge);
    const { message, events } = await outcome(stream);

    expect(events).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "Hello world" }]);
    await settle();
    expect(bridges, "a completed turn is never retried").toHaveLength(1);
  });

  it("reopens the warm bridge for the next turn instead of spawning another", async () => {
    const first = streamPi(context(user(PROMPT)));
    const bridge = await spawned(0);
    bridge.send(cursor.text("Hello world"), cursor.turnEnded());
    bridge.finishStream();
    const { message: answer } = await outcome(first);

    const second = streamPi(context(user(PROMPT), answer, user("Which file did you read?")));
    await settle();
    expect(bridges, "no second bridge").toHaveLength(1);
    expect(bridge.reopened).toBe(1);
    expect(runRequests(bridge).map(userText)).toEqual([PROMPT, "Which file did you read?"]);

    const { message } = await finishWithText(bridge, second);
    expect(message.stopReason).toBe("stop");
  });
});

describe("native stream contract: Pi tool calls", () => {
  it("hands Cursor's tool call to Pi and answers it on the parked bridge", async () => {
    const stream = streamPi(context(user(PROMPT)));
    const bridge = await spawned(0);
    bridge.send(cursor.readFile("README.md"));
    const { message: toolUse, events } = await outcome(stream);

    expect(events).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
    expect(toolUse.stopReason).toBe("toolUse");
    expect(toolUse.content).toEqual([
      { type: "toolCall", id: TOOL_CALL_ID, name: "read", arguments: { path: "README.md" } },
    ]);
    expect(execReplies(bridge), "the exec stays open until Pi has a result").toEqual([]);

    const resumed = streamReadResult(toolUse);
    await settle();
    expect(bridges, "the result goes to the parked bridge").toHaveLength(1);
    const replies = execReplies(bridge);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.id).toBe(EXEC_MSG_ID);
    expect(replies[0]!.execId).toBe(EXEC_ID);
    const reply = replies[0]!.message;
    expect(reply.case).toBe("mcpResult");
    const result = reply.case === "mcpResult" ? reply.value.result : undefined;
    expect(result?.case).toBe("success");
    if (result?.case === "success") {
      expect(result.value.isError).toBe(false);
      expect(
        result.value.content.map((item) =>
          item.content.case === "text" ? item.content.value.text : "",
        ),
      ).toEqual([README]);
    }

    const { message, events: resumedEvents } = await finishWithText(bridge, resumed);
    expect(resumedEvents).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(message.stopReason).toBe("stop");
    expect(textOf(message)).toBe("README describes the Pi provider.");
  });
});

describe("native stream contract: transport loss and retries", () => {
  it.each([
    ["GOAWAY", (bridge: FakeBridge) => bridge.goaway()],
    ["connection reset", (bridge: FakeBridge) => bridge.resetConnection()],
  ])("replays the request on a new bridge after a %s before any output", async (_label, lose) => {
    const stream = streamPi(context(user(PROMPT)));
    const first = await spawned(0);
    lose(first);

    const second = await spawned(1);
    const retried = onlyRunRequest(second);
    expect(userText(retried)).toBe(PROMPT);
    expect(retried.conversationId).toBe(onlyRunRequest(first).conversationId);
    expect(tokenRequests, "the retry force-refreshes the token").toEqual([
      undefined,
      { forceRefresh: true },
    ]);

    const { message, events } = await finishWithText(second, stream);
    expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(message.stopReason).toBe("stop");
    expect(bridges).toHaveLength(2);
  });

  it("gives up once a recurring transport loss spends the retry budget", async () => {
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "2";
    const stream = streamPi(context(user(PROMPT)));
    for (let attempt = 0; attempt < 3; attempt++) (await spawned(attempt)).goaway();
    const { message } = await outcome(stream);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/GOAWAY/);
    await settle();
    expect(bridges, "one first attempt plus two retries").toHaveLength(3);
  });

  it("retries a rate-limited turn once, replaying the same request", async () => {
    const stream = streamPi(context(user(PROMPT)));
    const first = await spawned(0);
    first.failStream("resource_exhausted", "rate limit exceeded");
    const second = await spawned(1);
    second.failStream("resource_exhausted", "rate limit exceeded");
    const { message } = await outcome(stream);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/resource_exhausted/);
    await settle();
    expect(bridges, "rate limits get a single retry").toHaveLength(2);
    expect(onlyRunRequest(second).conversationId).toBe(onlyRunRequest(first).conversationId);
  });

  it("fails rather than replays when text was streamed and no checkpoint exists", async () => {
    const stream = streamPi(context(user(PROMPT)));
    const bridge = await spawned(0);
    bridge.send(cursor.text("Partial answer"));
    bridge.goaway();
    const { message, events } = await outcome(stream);

    expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/GOAWAY/);
    expect(textOf(message)).toBe("Partial answer");
    await settle();
    expect(bridges, "partial output is never blindly replayed").toHaveLength(1);
  });

  it("continues from Cursor's checkpoint when text was streamed before the loss", async () => {
    const stream = streamPi(context(user(PROMPT)));
    const first = await spawned(0);
    first.send(cursor.checkpoint(), cursor.text("Partial answer"));
    first.goaway();

    const second = await spawned(1);
    const continued = onlyRunRequest(second);
    expect(userText(continued)).toBe(CHECKPOINT_CONTINUATION_PROMPT);
    expect(continued.conversationState?.readPaths, "resumes Cursor's checkpoint").toContain(
      CHECKPOINT_MARKER,
    );
    expect(continued.conversationId).toBe(onlyRunRequest(first).conversationId);
    expectReferencedBlobsServed(second, continued);

    second.send(cursor.text(" and the rest."), cursor.turnEnded());
    second.finishStream();
    const { message, events } = await outcome(stream);
    expect(events).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
    expect(message.stopReason).toBe("stop");
    expect(textOf(message)).toBe("Partial answer and the rest.");
  });

  it("cancels the run and closes the bridge when Pi aborts mid-stream", async () => {
    const controller = new AbortController();
    const stream = streamPi(context(user(PROMPT)), controller.signal);
    const bridge = await spawned(0);
    bridge.send(cursor.text("Partial answer"));
    controller.abort();
    const { message, events } = await outcome(stream);

    expect(events.at(-1)).toBe("error");
    expect(message.stopReason).toBe("aborted");
    expect(textOf(message)).toBe("Partial answer");
    expect(lastAction(bridge), "Cursor is told to cancel the run").toBe("cancelAction");
    expect(bridge.endedByClient).toBe(1);
    await settle();
    expect(bridges, "an aborted turn is not retried").toHaveLength(1);
  });
});

describe("native stream contract: tool continuation after the bridge is lost", () => {
  async function expectRecoveredOnNewBridge(
    resumed: AssistantMessageEventStream,
    expected: { checkpoint: boolean; sameConversation: boolean; replayedTurns: number },
  ) {
    const recovery = await spawned(1);
    const run = onlyRunRequest(recovery);
    const text = userText(run) ?? "";
    expect(text, "the tool output reaches Cursor").toContain(README);
    expect(text).toContain(TOOL_CALL_ID);
    expect(run.conversationState?.readPaths.includes(CHECKPOINT_MARKER)).toBe(expected.checkpoint);
    expect(run.conversationState?.turns, "history replayed as turns").toHaveLength(
      expected.replayedTurns,
    );
    const firstConversation = onlyRunRequest(bridges[0]!).conversationId;
    if (expected.sameConversation) expect(run.conversationId).toBe(firstConversation);
    else expect(run.conversationId).not.toBe(firstConversation);
    expectReferencedBlobsServed(recovery, run);

    const { message } = await finishWithText(recovery, resumed);
    expect(message.stopReason).toBe("stop");
    expect(textOf(message)).toBe("README describes the Pi provider.");
    expect(bridges).toHaveLength(2);
  }

  it("rebuilds the in-flight turn when the parked bridge GOAWAYs before the result", async () => {
    const { bridge, toolUse } = await pauseOnReadTool();
    bridge.goaway();
    await settle();
    expect(bridges, "the original prompt is not replayed behind Pi's back").toHaveLength(1);

    await expectRecoveredOnNewBridge(streamReadResult(toolUse), {
      checkpoint: false,
      sameConversation: true,
      replayedTurns: 1,
    });
    expect(execReplies(bridge), "nothing is written to the dead bridge").toEqual([]);
  });

  it("resumes from the saved checkpoint when the parked stream ends in a terminal error", async () => {
    const { bridge, toolUse } = await pauseOnReadTool();
    bridge.send(cursor.checkpoint());
    bridge.failStream("invalid_argument", "request rejected");
    await settle();
    expect(bridges).toHaveLength(1);

    await expectRecoveredOnNewBridge(streamReadResult(toolUse), {
      checkpoint: true,
      sameConversation: true,
      replayedTurns: 0,
    });
  });

  it("drops a checkpoint that preceded a mid-pause GOAWAY and rebuilds on a new conversation", async () => {
    const { bridge, toolUse } = await pauseOnReadTool();
    bridge.send(cursor.checkpoint());
    bridge.goaway();
    await settle();
    expect(bridges).toHaveLength(1);

    await expectRecoveredOnNewBridge(streamReadResult(toolUse), {
      checkpoint: false,
      sameConversation: false,
      replayedTurns: 1,
    });
  });

  it("rebuilds on a new bridge when the bridge GOAWAYs after the result was sent", async () => {
    const { bridge, toolUse } = await pauseOnReadTool();
    const resumed = streamReadResult(toolUse);
    await settle();
    expect(execReplies(bridge), "the result went to the parked bridge first").toHaveLength(1);
    bridge.goaway();

    await expectRecoveredOnNewBridge(resumed, {
      checkpoint: false,
      sameConversation: true,
      replayedTurns: 1,
    });
  });

  it("resumes from the checkpoint when the bridge GOAWAYs after the result was sent", async () => {
    const { bridge, toolUse } = await pauseOnReadTool();
    bridge.send(cursor.checkpoint());
    const resumed = streamReadResult(toolUse);
    await settle();
    expect(execReplies(bridge)).toHaveLength(1);
    bridge.goaway();

    await expectRecoveredOnNewBridge(resumed, {
      checkpoint: true,
      sameConversation: true,
      replayedTurns: 0,
    });
  });
});

describe("native stream contract: idle watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  const idleOut = () => vi.advanceTimersByTime(DEFAULT_IDLE_TIMEOUT_MS);

  it("restarts a silent stream on a new bridge without spending the retry budget", async () => {
    process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES = "0";
    const stream = streamPi(context(user(PROMPT)));
    const first = await spawned(0);
    idleOut();
    const second = await spawned(1);
    idleOut();
    const third = await spawned(2);

    expect([first, second].map(lastAction), "each silent run is cancelled").toEqual([
      "cancelAction",
      "cancelAction",
    ]);
    expect([second, third].map((bridge) => userText(onlyRunRequest(bridge)))).toEqual([
      PROMPT,
      PROMPT,
    ]);
    const { message } = await finishWithText(third, stream);
    expect(message.stopReason).toBe("stop");
    expect(bridges).toHaveLength(3);
  });

  it("fails a stream that idles out after text when there is no checkpoint", async () => {
    const stream = streamPi(context(user(PROMPT)));
    const bridge = await spawned(0);
    bridge.send(cursor.text("Partial answer"));
    idleOut();
    const { message } = await outcome(stream);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/idle timeout/);
    expect(textOf(message)).toBe("Partial answer");
    expect(lastAction(bridge)).toBe("cancelAction");
    await settle();
    expect(bridges, "partial output is never blindly replayed").toHaveLength(1);
  });

  it("replays the original request when a stream idles out after text and a checkpoint", async () => {
    const stream = streamPi(context(user(PROMPT)));
    const first = await spawned(0);
    first.send(cursor.checkpoint(), cursor.text("Partial answer"));
    idleOut();

    const second = await spawned(1);
    const replay = onlyRunRequest(second);
    expect(userText(replay)).toBe(PROMPT);
    expect(replay.conversationState?.readPaths).not.toContain(CHECKPOINT_MARKER);

    const { message } = await finishWithText(second, stream);
    expect(message.stopReason).toBe("stop");
    // Pins current behavior: the partial text stays and the full answer is regenerated after it.
    expect(textOf(message)).toBe("Partial answerREADME describes the Pi provider.");
  });
});
