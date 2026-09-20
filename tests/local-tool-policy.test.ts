import { afterEach, describe, expect, it, vi } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  type ExecServerMessage,
} from "../src/proto/agent_pb.js";
import { frameConnectMessage } from "../src/client/bridge.js";
import {
  buildCursorRequest,
  buildMcpToolDefinitions,
  encodeMcpArgsMap,
} from "../src/stream/request-build.js";
import { localToolPolicyText, nativeToolRejectReason } from "../src/stream/local-tool-policy.js";
import * as nativeExec from "../src/stream/exec-native.js";
import { __testInternals as server } from "../src/stream/server-messages.js";
import { __testInternals as native } from "../src/stream/native-core.js";
import {
  activeBridges,
  destroyAllIdleBridges,
  removeActiveBridge,
} from "../src/stream/bridge-session.js";
import type { NativeStreamWriter, StreamIdleRetryController } from "../src/stream/types.js";

function tools(...names: string[]) {
  return buildMcpToolDefinitions(
    names.map((name) => ({
      type: "function",
      function: {
        name,
        description: name,
        parameters: { type: "object" },
      },
    })),
  );
}

function exec(caseName: string, args: object = {}, id = 12): ExecServerMessage {
  return {
    id,
    execId: `exec-${id}`,
    message: { case: caseName, value: args },
  } as ExecServerMessage;
}

function execFrame(caseName: string, args: object = {}, id = 12) {
  return frameConnectMessage(
    toBinary(
      AgentServerMessageSchema,
      create(AgentServerMessageSchema, {
        message: { case: "execServerMessage", value: exec(caseName, args, id) },
      }),
    ),
  );
}

const localCases = [
  ["readArgs", "readResult", "rejected"],
  ["lsArgs", "lsResult", "rejected"],
  ["grepArgs", "grepResult", "error"],
  ["writeArgs", "writeResult", "rejected"],
  ["deleteArgs", "deleteResult", "rejected"],
  ["shellArgs", "shellResult", "rejected"],
  ["shellStreamArgs", "shellStream", "rejected"],
  ["backgroundShellSpawnArgs", "backgroundShellSpawnResult", "rejected"],
  ["writeShellStdinArgs", "writeShellStdinResult", "error"],
];

describe("Pi-only local tool routing", () => {
  it.each(localCases)(
    "answers %s using %s without dispatching work",
    (request, reply, resultCase) => {
      const dispatch = vi.spyOn(nativeExec, "dispatchNativeExec").mockImplementation(() => {
        throw new Error("local requests must be rejected before native dispatch");
      });
      const frames: Uint8Array[] = [];
      const onMcp = vi.fn();
      const onWork = vi.fn();
      expect(
        server.handleExecMessageInner(
          exec(request!, { path: "missing", pattern: "needle", command: "echo unexpected" }),
          tools("bash"),
          (frame) => frames.push(frame),
          onMcp,
          onWork,
        ),
      ).toBe(true);
      expect(onMcp).not.toHaveBeenCalled();
      expect(onWork).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(frames).toHaveLength(1);
      const answer = fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5));
      expect(answer).toMatchObject({
        message: {
          case: "execClientMessage",
          value: {
            id: 12,
            execId: "exec-12",
            message: {
              case: reply,
              value: {
                [reply === "shellStream" ? "event" : "result"]: { case: resultCase },
              },
            },
          },
        },
      });
      expect(JSON.stringify(answer)).toContain("mcp_pi_bash");
      expect(JSON.stringify(answer)).toContain("No operation was performed");
      expect(JSON.stringify(answer)).toContain("Do not retry this native Cursor tool");
    },
  );

  it("prefers a matching tool, follows its schema, and only suggests registered names", () => {
    const reason = nativeToolRejectReason("grepArgs", tools("grep", "bash"));
    expect(reason).toContain("mcp_pi_grep, mcp_pi_bash");
    expect(reason).toContain("according to its schema");
    expect(reason).not.toContain("with the same arguments");
    expect(nativeToolRejectReason("grepArgs", tools("bash"))).not.toContain("mcp_pi_grep");
    const custom = nativeToolRejectReason("grepArgs", tools("search_repository"));
    expect(custom).toContain("mcp_pi_search_repository");
    expect(custom).not.toContain("mcp_pi_bash");
    expect(nativeToolRejectReason("shellArgs", [])).toContain("cannot be performed");
  });

  it.each([
    ["grepArgs", ["bash", "search_repository"], "mcp_pi_search_repository, mcp_pi_bash"],
    ["writeArgs", ["bash", "edit"], "mcp_pi_edit, mcp_pi_bash"],
    ["writeArgs", ["bash", "Edit"], "mcp_pi_Edit, mcp_pi_bash"],
    ["deleteArgs", ["bash", "delete_file"], "mcp_pi_delete_file, mcp_pi_bash"],
  ] as const)("keeps specialized tools visible for %s", (execCase, available, expected) => {
    expect(nativeToolRejectReason(execCase, tools(...available))).toContain(expected);
  });

  it("scopes missing tools to the current request, including tool-free greetings", () => {
    const policy = localToolPolicyText([]);
    expect(policy).toContain("No Pi MCP tools are exposed for this request");
    expect(policy).toContain("do not call or retry them");
    expect(policy).not.toContain("No Pi MCP tools are registered");
  });

  it("keeps the prompt compact without hiding custom tools behind a no-tools claim", () => {
    const policy = localToolPolicyText(tools("bash", "web_search", "search_repository"));
    expect(policy).toContain("mcp_pi_bash");
    expect(policy).not.toContain("mcp_pi_web_search");
    expect(policy).toContain("Other exposed Pi tools");
    expect(localToolPolicyText(tools("search_repository"))).not.toContain("No Pi MCP tools");
  });

  it("still executes fetch through the async native path", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("web content"));
    vi.stubGlobal("fetch", fetch);
    try {
      const frames: Uint8Array[] = [];
      const work: Promise<void>[] = [];
      const onMcp = vi.fn();
      expect(
        server.handleExecMessageInner(
          exec("fetchArgs", { url: "https://example.com/" }),
          tools("bash"),
          (frame) => frames.push(frame),
          onMcp,
          (pending) => work.push(pending),
        ),
      ).toBe(true);
      expect(work).toHaveLength(1);
      await Promise.all(work);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onMcp).not.toHaveBeenCalled();
      expect(frames).toHaveLength(1);
      expect(fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5))).toMatchObject({
        message: {
          case: "execClientMessage",
          value: {
            id: 12,
            execId: "exec-12",
            message: {
              case: "fetchResult",
              value: { result: { case: "success", value: { content: "web content" } } },
            },
          },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["**/*.ts", "*.{ts,js}"])(
    "hands %s to Pi without applying native grep semantics",
    (glob) => {
      const onMcp = vi.fn();
      const send = vi.fn();
      const args = { pattern: "needle", path: ".", glob };
      expect(
        server.handleExecMessageInner(
          exec("mcpArgs", {
            toolName: "mcp_pi_grep",
            toolCallId: "search",
            args: encodeMcpArgsMap(args),
          }),
          tools("grep"),
          send,
          onMcp,
        ),
      ).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(onMcp).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "grep", decodedArgs: JSON.stringify(args) }),
      );
    },
  );

  it.each([false, true])(
    "publishes the policy with history disabled (checkpoint=%s)",
    (checkpoint) => {
      vi.stubEnv("PI_CURSOR_PROMPT_HISTORY", "0");
      try {
        const payload = buildCursorRequest({
          modelId: "cursor-grok-4.6",
          systemPrompt: "PRIVATE SYSTEM",
          userText: "search",
          turns: [{ userText: "OLD HISTORY", steps: [] }],
          conversationId: "policy",
          checkpoint: checkpoint
            ? toBinary(
                ConversationStateStructureSchema,
                create(ConversationStateStructureSchema, {}),
              )
            : null,
          mcpTools: tools("bash"),
        });
        const message = fromBinary(AgentClientMessageSchema, payload.requestBytes);
        if (message.message.case !== "runRequest") throw new Error("missing run request");
        const messages = message.message.value.conversationState!.rootPromptMessagesJson.map(
          (id) =>
            JSON.parse(
              new TextDecoder().decode(payload.blobStore.get(Buffer.from(id).toString("hex"))!),
            ) as { role: string },
        );
        const prompt = JSON.stringify(messages.filter((message) => message.role === "user"));
        expect(prompt).toContain("Native Cursor local tools are disabled");
        expect(prompt).toContain("mcp_pi_bash");
        expect(prompt).not.toContain("PRIVATE SYSTEM");
        expect(prompt).not.toContain("OLD HISTORY");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

function writer() {
  return {
    output: {} as never,
    closed: false,
    start: vi.fn(),
    text: vi.fn(),
    thinking: vi.fn(),
    toolCall: vi.fn(),
    done: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
    error: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  removeActiveBridge("local-policy");
  destroyAllIdleBridges();
  vi.restoreAllMocks();
});

function harness(retry?: StreamIdleRetryController) {
  const controller = new AbortController();
  let onData = (_chunk: Buffer) => {};
  let onClose = (_code: number) => {};
  const bridge = {
    proc: { kill: vi.fn(() => true) },
    alive: true,
    lastStderr: () => "",
    write: vi.fn(),
    end: vi.fn(),
    onData: (cb: typeof onData) => {
      onData = cb;
    },
    onClose: (cb: typeof onClose) => {
      onClose = cb;
    },
  };
  const output = writer();
  const timer = setInterval(() => {}, 60_000);
  native.writeNativeStream(
    bridge,
    timer,
    new Map(),
    tools("bash", "grep"),
    {} as never,
    "cursor-grok-4.6",
    "local-policy",
    "local-policy",
    [],
    { userText: "search", steps: [] },
    output as NativeStreamWriter,
    { signal: controller.signal } as never,
    "policy-test",
    retry,
    0,
  );
  cleanups.push(() => {
    controller.abort();
    clearInterval(timer);
  });
  return {
    bridge,
    output,
    controller,
    send: (chunk: Buffer) => onData(chunk),
    close: () => onClose(1),
  };
}

describe("local tool rejection budget on the stream", () => {
  it("stops after eight mixed rejections despite text and heartbeat progress, without retrying", () => {
    const retry = { currentAttempt: 1, maxRetries: 3, restart: vi.fn(() => true) };
    const h = harness(retry);
    for (let i = 0; i < 8; i++) {
      h.send(execFrame(i % 2 ? "readArgs" : "grepArgs", {}, i));
      if (i < 7) {
        h.send(
          frameConnectMessage(
            toBinary(
              AgentServerMessageSchema,
              create(AgentServerMessageSchema, {
                message: {
                  case: "interactionUpdate",
                  value: { message: { case: "textDelta", value: { text: "retry" } } },
                },
              }),
            ),
          ),
        );
        h.send(
          frameConnectMessage(
            toBinary(
              AgentServerMessageSchema,
              create(AgentServerMessageSchema, {
                message: {
                  case: "interactionUpdate",
                  value: { message: { case: "heartbeat", value: {} } },
                },
              }),
            ),
          ),
        );
        expect(h.output.error).not.toHaveBeenCalled();
      }
    }
    expect(h.output.error).toHaveBeenCalledTimes(1);
    expect(h.output.error.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.stringContaining("8 requests")]),
    );
    expect(h.bridge.end).toHaveBeenCalledTimes(1);
    h.close();
    expect(retry.restart).not.toHaveBeenCalled();
    h.send(execFrame("grepArgs"));
    expect(h.output.error).toHaveBeenCalledTimes(1);
  });

  it("preserves the budget across transport attempts", () => {
    const retry = {
      currentAttempt: 1,
      maxRetries: 3,
      restart: vi.fn(() => true),
      localToolRejections: 0,
    };
    const first = harness(retry);
    for (let i = 0; i < 7; i++) first.send(execFrame("grepArgs"));
    expect(retry.localToolRejections).toBe(7);
    first.controller.abort();
    const next = harness(retry);
    next.send(execFrame("readArgs"));
    expect(next.output.error).toHaveBeenCalledTimes(1);
  });

  it("does not let an unknown MCP tool reset the budget", () => {
    const h = harness();
    for (let i = 0; i < 7; i++) h.send(execFrame("grepArgs"));
    h.send(execFrame("mcpArgs", { toolName: "missing", toolCallId: "missing" }));
    expect(h.output.toolCall).not.toHaveBeenCalled();
    h.send(execFrame("grepArgs"));
    expect(h.output.error).toHaveBeenCalledTimes(1);
  });

  it("starts a new user turn with a fresh budget after cancellation", () => {
    const first = harness();
    for (let i = 0; i < 7; i++) first.send(execFrame("grepArgs"));
    first.controller.abort();
    expect(first.bridge.end).toHaveBeenCalledTimes(1);
    const next = harness();
    next.send(execFrame("grepArgs"));
    expect(next.output.error).not.toHaveBeenCalled();
  });

  it("does not revive a stopped run for a Pi call arriving in a later chunk", () => {
    const h = harness();
    h.send(Buffer.concat(Array.from({ length: 8 }, () => execFrame("grepArgs"))));
    expect(h.output.error).toHaveBeenCalledTimes(1);
    h.send(execFrame("mcpArgs", { toolName: "bash", toolCallId: "late" }));
    expect(h.output.toolCall).not.toHaveBeenCalled();
    expect(h.bridge.end).toHaveBeenCalledTimes(1);
  });

  it("prioritizes parallel Pi calls in the same chunk and resets after their results", () => {
    const h = harness();
    h.send(
      Buffer.concat([
        ...Array.from({ length: 8 }, () => execFrame("grepArgs")),
        execFrame("mcpArgs", { toolName: "mcp_pi_bash", toolCallId: "pi-1" }, 21),
        execFrame("mcpArgs", { toolName: "grep", toolCallId: "pi-2" }, 22),
      ]),
    );
    expect(h.output.error).not.toHaveBeenCalled();
    expect(h.output.toolCall).toHaveBeenCalledTimes(2);
    expect(h.output.done).toHaveBeenCalledWith("toolUse", expect.anything());
    const active = activeBridges.get("local-policy")!;
    expect(active.pendingExecs).toHaveLength(2);
    const context = {
      accessToken: "unused",
      systemPrompt: "",
      model: {} as never,
      modelId: "cursor-grok-4.6",
      bridgeKey: "local-policy",
      convKey: "local-policy",
      sessionId: undefined,
      completedTurns: [],
      maxMode: false,
      cursorModelParameters: [],
    };
    // A partial result does not yet go on the wire or reset the budget.
    const partial = writer();
    native.handleNativeToolResultResume(
      active,
      [{ toolCallId: "pi-1", content: "src/a.ts", isError: false }],
      context,
      partial as NativeStreamWriter,
      { signal: h.controller.signal } as never,
    );
    expect(active.state.localToolRejections).toBe(8);
    expect(partial.toolCall).toHaveBeenCalledTimes(1);
    expect(partial.error).not.toHaveBeenCalled();
    h.send(execFrame("readArgs"));
    expect(active.state.localToolRejections).toBe(9);
    expect(h.output.error).not.toHaveBeenCalled();
    const resumed = writer();
    native.handleNativeToolResultResume(
      activeBridges.get("local-policy")!,
      [{ toolCallId: "pi-2", content: "src/b.ts:1:needle", isError: false }],
      context,
      resumed as NativeStreamWriter,
      { signal: h.controller.signal } as never,
    );
    const replies = h.bridge.write.mock.calls.map(([frame]) =>
      fromBinary(AgentClientMessageSchema, (frame as Uint8Array).subarray(5)),
    );
    expect(
      replies.filter(
        (reply) =>
          reply.message.case === "execClientMessage" &&
          reply.message.value.message.case === "mcpResult",
      ),
    ).toHaveLength(2);
    h.send(
      frameConnectMessage(
        toBinary(
          AgentServerMessageSchema,
          create(AgentServerMessageSchema, {
            message: {
              case: "interactionUpdate",
              value: { message: { case: "textDelta", value: { text: "Found both files." } } },
            },
          }),
        ),
      ),
    );
    expect(resumed.text).toHaveBeenCalledWith("Found both files.");
    for (let i = 0; i < 7; i++) h.send(execFrame("grepArgs"));
    expect(resumed.error).not.toHaveBeenCalled();
    h.send(execFrame("grepArgs"));
    expect(resumed.error).toHaveBeenCalledTimes(1);
  });
});
