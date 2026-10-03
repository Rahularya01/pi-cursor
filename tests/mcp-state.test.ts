import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  McpStateExecArgsSchema,
  type ExecClientMessage,
  type McpStateExecResult,
  type McpStateSuccess,
} from "../src/proto/agent_pb.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import { buildMcpToolDefinitions } from "../src/stream/tool-schema.js";
import type { StreamState } from "../src/stream/types.js";

const mcpTools = buildMcpToolDefinitions([
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
]);

function answerMcpState(serverIdentifiers: string[]): McpStateSuccess {
  // Round-trip through bytes: Cursor sends this exec as ExecServerMessage field 36,
  // which used to decode as startGrindPlanningArgs.
  const message = fromBinary(
    AgentServerMessageSchema,
    toBinary(
      AgentServerMessageSchema,
      create(AgentServerMessageSchema, {
        message: {
          case: "execServerMessage",
          value: create(ExecServerMessageSchema, {
            id: 1,
            execId: "exec-1",
            message: {
              case: "mcpStateExecArgs",
              value: create(McpStateExecArgsSchema, { serverIdentifiers }),
            },
          }),
        },
      }),
    ),
  );
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
      new Map(),
      mcpTools,
      (frame) => frames.push(frame),
      state,
      () => {},
      () => {},
    ),
  ).toBe("work");
  expect(frames).toHaveLength(1);

  const answer = fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5));
  expect(answer.message.case).toBe("execClientMessage");
  const exec = answer.message.value as ExecClientMessage;
  expect(exec.message.case).toBe("mcpStateExecResult");
  const result = exec.message.value as McpStateExecResult;
  expect(result.result.case).toBe("success");
  return result.result.value as McpStateSuccess;
}

describe("mcpStateExecArgs reply", () => {
  it("lists the Pi tools under the pi server, so GetDynamicTools finds the pi namespace (#40)", () => {
    const success = answerMcpState([]);
    expect(success.servers).toHaveLength(1);
    const [server] = success.servers;
    expect(server!.serverIdentifier).toBe("pi");
    expect(server!.serverName).toBe("pi");
    expect(server!.tools.map((tool) => tool.toolName)).toEqual(["get_weather"]);
    expect(server!.tools[0]!.description).toBe("Get the current weather for a city");
    expect(server!.tools[0]!.inputSchema.byteLength).toBeGreaterThan(0);
  });

  it("answers only the servers Cursor asked for", () => {
    expect(answerMcpState(["pi"]).servers.map((server) => server.serverIdentifier)).toEqual(["pi"]);
    expect(answerMcpState(["github"]).servers).toEqual([]);
  });
});
