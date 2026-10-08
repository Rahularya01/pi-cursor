import { create, fromBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  McpArgsSchema,
  McpToolDefinitionSchema,
  type McpToolDefinition,
} from "../src/proto/agent_pb.js";
import {
  availableToolNamesFor,
  localToolPolicyText,
  nativeToolRejectReason,
} from "../src/stream/local-tool-policy.js";
import { buildCursorRequest, encodeMcpArgsMap } from "../src/stream/request-build.js";
import {
  buildRootPromptMessages,
  cursorMcpToolName,
  turnRootMessages,
} from "../src/stream/root-prompt.js";
import { mcpStateServersFor, processServerMessage } from "../src/stream/server-messages.js";
import { buildMcpToolDefinitions } from "../src/stream/tool-schema.js";
import type { PendingExec, StreamState } from "../src/stream/types.js";

const previousSlimTools = process.env.PI_CURSOR_SLIM_TOOLS;
afterEach(() => {
  if (previousSlimTools === undefined) delete process.env.PI_CURSOR_SLIM_TOOLS;
  else process.env.PI_CURSOR_SLIM_TOOLS = previousSlimTools;
});

function piTools(): McpToolDefinition[] {
  return buildMcpToolDefinitions([
    {
      type: "function",
      function: {
        name: "bash",
        description: "Execute a bash command.",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "Shell command to execute." } },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit",
        description: "Edit a file using exact text replacement.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to edit." },
            oldText: { type: "string", description: "Exact original text, including whitespace." },
            newText: { type: "string", description: "Replacement text." },
          },
          required: ["path", "oldText", "newText"],
        },
      },
    },
  ]);
}

function state(): StreamState {
  return { toolCallIndex: 0, pendingExecs: [], outputTokens: 0, totalTokens: 0, turnEnded: false };
}

// Test-only protobuf framing with fixed Cursor field numbers, independent of
// Pi's generated message descriptors. A schema self-round-trip cannot pin tags.
function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0));
    value >>>= 7;
  } while (value);
  return Buffer.from(bytes);
}

function field(no: number, value: Uint8Array | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([varint((no << 3) | 2), varint(bytes.length), bytes]);
}

function bytesFields(bytes: Uint8Array, no: number): Uint8Array[] {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (offset < bytes.length && shift < 35) {
      const byte = bytes[offset++]!;
      value |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value >>> 0;
      shift += 7;
    }
    throw new Error("Invalid fixture varint");
  };
  const found: Uint8Array[] = [];
  while (offset < bytes.length) {
    const tag = readVarint();
    if ((tag & 7) === 0) {
      readVarint();
    } else if ((tag & 7) === 2) {
      const length = readVarint();
      if (offset + length > bytes.length) throw new Error("Truncated fixture field");
      if (tag >>> 3 === no) found.push(bytes.subarray(offset, offset + length));
      offset += length;
    } else {
      throw new Error(`Unexpected fixture wire type ${tag & 7}`);
    }
  }
  return found;
}

function onlyField(bytes: Uint8Array, no: number): Uint8Array {
  const values = bytesFields(bytes, no);
  expect(values).toHaveLength(1);
  return values[0]!;
}

function text(bytes: Uint8Array, no: number): string {
  return new TextDecoder().decode(onlyField(bytes, no));
}

interface DiscoveredServer {
  serverIdentifier: string;
  tools: Array<{
    name: string;
    toolName: string;
    description: string;
    schema: JsonValue;
    schemaJson: JsonValue;
  }>;
}

function answerMcpState(
  serverIdentifiers: string[],
  tools = piTools(),
  fixture?: Uint8Array,
): DiscoveredServer[] {
  // AgentServerMessage.exec_server_message=2; ExecServerMessage.id=1,
  // exec_id=15, mcp_state_exec_args=36; server_identifiers=1.
  const args = Buffer.concat(serverIdentifiers.map((id) => field(1, id)));
  const wire =
    fixture ?? field(2, Buffer.concat([Buffer.from([8, 1]), field(15, "x"), field(36, args)]));
  const message = fromBinary(AgentServerMessageSchema, wire);
  const frames: Uint8Array[] = [];
  expect(
    processServerMessage(
      message,
      new Map(),
      tools,
      (frame) => frames.push(frame),
      state(),
      () => {},
      () => {},
    ),
  ).toBe("work");
  expect(frames).toHaveLength(1);
  const frame = frames[0]!;
  expect(frame[0]).toBe(0);
  expect(Buffer.from(frame).readUInt32BE(1)).toBe(frame.length - 5);

  // Decode the reply by Cursor's numeric tags, not Pi's outgoing schema:
  // AgentClientMessage.exec_client_message=2; result=36; success=1; servers=1.
  const exec = onlyField(frame.subarray(5), 2);
  expect(text(exec, 15)).toBe("x");
  const success = onlyField(onlyField(exec, 36), 1);
  return bytesFields(success, 1).map((server) => ({
    serverIdentifier: text(server, 2),
    tools: bytesFields(server, 5).map((tool) => ({
      name: text(tool, 1),
      description: text(tool, 2),
      toolName: text(tool, 5),
      // Cursor's Value field 3 and preferred JSON field 6 must agree.
      schema: toJson(ValueSchema, fromBinary(ValueSchema, onlyField(tool, 3))),
      schemaJson: JSON.parse(text(tool, 6)) as JsonValue,
    })),
  }));
}

function invoke(toolName: string, tools: McpToolDefinition[]): PendingExec[] {
  const pending: PendingExec[] = [];
  const frames: Uint8Array[] = [];
  const message = create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id: 2,
        execId: "invoke",
        message: {
          case: "mcpArgs",
          value: create(McpArgsSchema, {
            name: toolName,
            toolName,
            providerIdentifier: "pi",
            toolCallId: "call-discovered",
            args: encodeMcpArgsMap({ command: "pwd" }),
          }),
        },
      }),
    },
  });
  processServerMessage(
    message,
    new Map(),
    tools,
    (frame) => frames.push(frame),
    state(),
    () => {},
    (exec) => pending.push(exec),
  );
  expect(frames).toHaveLength(0);
  expect(pending).toHaveLength(1);
  return pending;
}

function catalogNames(tools: McpToolDefinition[]): string[][] {
  return tools.map((tool) => [tool.name, tool.toolName]);
}

/** The tool catalog a RunRequest built for `tools` sends to Cursor. */
function runRequestCatalog(tools: McpToolDefinition[]): McpToolDefinition[] {
  const run = fromBinary(
    AgentClientMessageSchema,
    buildCursorRequest({
      modelId: "cursor-grok-4.6",
      systemPrompt: "",
      userText: "run",
      turns: [],
      conversationId: "catalog",
      checkpoint: null,
      mcpTools: tools,
    }).requestBytes,
  );
  if (run.message.case !== "runRequest") throw new Error("missing run request");
  return run.message.value.mcpTools!.mcpTools;
}

/** The tool catalog our reply to Cursor's `requestContextArgs` exec carries. */
function requestContextCatalog(tools: McpToolDefinition[]): McpToolDefinition[] {
  const frames: Uint8Array[] = [];
  processServerMessage(
    create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: 3,
          execId: "context",
          message: { case: "requestContextArgs", value: {} },
        }),
      },
    }),
    new Map(),
    tools,
    (frame) => frames.push(frame),
    state(),
    () => {},
    () => {},
  );
  const reply = fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5));
  if (reply.message.case !== "execClientMessage") throw new Error("missing exec reply");
  const context = reply.message.value.message;
  if (context.case !== "requestContextResult" || context.value.result.case !== "success")
    throw new Error("missing request context");
  return context.value.result.value.requestContext!.tools;
}

describe("Cursor MCP discovery compatibility", () => {
  it("answers an independent field-36 request fixture with a field-36 result", () => {
    // Hand-encoded request for server pi, not built with McpStateExecArgsSchema.
    const fixture = Buffer.from("120c08017a0178a202040a027069", "hex");
    expect(answerMcpState([], piTools(), fixture)[0]!.serverIdentifier).toBe("pi");
  });

  it("discovers precisely the names advertised by policy, rejections, and replayed history", () => {
    const tools = piTools();
    const catalog = answerMcpState([])[0]!.tools;
    for (const raw of tools) {
      const advertised = cursorMcpToolName(raw.toolName);
      expect(localToolPolicyText(tools)).toContain(advertised);
      expect(nativeToolRejectReason("shellArgs", tools)).toContain(advertised);
      expect(catalog.filter((tool) => tool.toolName === advertised)).toHaveLength(1);
    }
    const history = turnRootMessages({
      userText: "show cwd",
      steps: [
        { kind: "toolCall", toolName: "bash", toolCallId: "old", arguments: { command: "pwd" } },
      ],
    });
    expect(JSON.stringify(history)).toContain('"toolName":"mcp_pi_bash"');
    expect(catalog.map((tool) => tool.toolName)).toEqual(["mcp_pi_bash", "mcp_pi_edit"]);
  });

  it.each(["0", "1"])(
    "retains edit argument semantics in both schema encodings with slimming=%s",
    (mode) => {
      process.env.PI_CURSOR_SLIM_TOOLS = mode;
      const edit = answerMcpState([])[0]!.tools.find((tool) => tool.toolName === "mcp_pi_edit")!;
      expect(edit.schemaJson).toEqual(edit.schema);
      expect(edit.schema).toMatchObject({
        type: "object",
        required: ["path", "oldText", "newText"],
        properties: {
          oldText: { type: "string", description: "Exact original text, including whitespace." },
          newText: { type: "string", description: "Replacement text." },
        },
      });
    },
  );

  it("dispatches an exact discovered name through the unchanged raw Pi registry", () => {
    const tools = piTools();
    const before = tools.map((tool) => tool.toolName);
    const discovered = answerMcpState([], tools)[0]!.tools.find(
      (tool) => tool.toolName === "mcp_pi_bash",
    )!;
    const [exec] = invoke(discovered.toolName, tools);
    expect(exec!.toolName).toBe("bash");
    expect(JSON.parse(exec!.decodedArgs)).toEqual({ command: "pwd" });
    expect(tools.map((tool) => tool.toolName)).toEqual(before);
    expect(invoke("bash", tools)[0]!.toolName).toBe("bash");
  });

  it("does not double-prefix or misroute tools already named mcp_pi_*", () => {
    const tools = [
      create(McpToolDefinitionSchema, {
        ...piTools()[0]!,
        name: "mcp_pi_bash",
        toolName: "mcp_pi_bash",
      }),
    ];
    const discovered = answerMcpState([], tools)[0]!.tools[0]!;
    expect(discovered.toolName).toBe("mcp_pi_bash");
    expect(invoke(discovered.toolName, tools)[0]!.toolName).toBe("mcp_pi_bash");
    // Older history rendered this tool with one prefix more than it is advertised under now.
    expect(invoke("mcp_pi_mcp_pi_bash", tools)[0]!.toolName).toBe("mcp_pi_bash");
    // A prefix added to an advertised name still reaches its tool when nothing else claims it.
    expect(invoke("mcp_pi_mcp_pi_edit", piTools())[0]!.toolName).toBe("edit");
  });

  // `bash` and a custom `mcp_pi_bash` both advertised as `mcp_pi_bash` sent bash's discovered
  // calls to the custom tool. Renaming the custom tool on the wire to a name that still carried
  // the prefix let Cursor's own prefixing land on a third tool's advertised name. Wire names are
  // therefore never prefixed, and every path advertises exactly `mcp_pi_<wire>`.
  it.each([
    [["mcp_pi_bash"], ["bash", "edit", "bash_2"]],
    [
      ["mcp_pi_bash", "mcp_pi_mcp_pi_bash"],
      ["bash", "edit", "bash_2", "bash_3"],
    ],
  ])("keeps one name per tool with custom tools %j next to bash", (custom, expectedWire) => {
    const tools = [
      ...piTools(),
      ...custom.map((name) =>
        create(McpToolDefinitionSchema, { ...piTools()[0]!, name, toolName: name }),
      ),
    ];
    const registry = tools.map((tool) => tool.toolName);
    const advertised = expectedWire.map((wire) => `mcp_pi_${wire}`);
    // Discovery's `name` is the wire name too, so Cursor prefixing it gives the advertised name.
    expect(answerMcpState([], tools)[0]!.tools.map((tool) => [tool.name, tool.toolName])).toEqual(
      expectedWire.map((wire, i) => [wire, advertised[i]]),
    );

    // Both catalogs the model can see send the same wire names; the registry keeps Pi's names.
    const wirePairs = expectedWire.map((wire) => [wire, wire]);
    expect(catalogNames(runRequestCatalog(tools))).toEqual(wirePairs);
    expect(catalogNames(requestContextCatalog(tools))).toEqual(wirePairs);
    expect(tools.map((tool) => tool.toolName)).toEqual(registry);

    // Echoed wire names and Cursor-prefixed wire names both reach the tool they were sent for.
    registry.forEach((name, i) => {
      expect(invoke(expectedWire[i]!, tools)[0]!.toolName).toBe(name);
      expect(invoke(advertised[i]!, tools)[0]!.toolName).toBe(name);
    });
    // A raw registry name that is also another tool's advertised name means that tool.
    expect(invoke("mcp_pi_bash", tools)[0]!.toolName).toBe("bash");
    // `mcp_pi_` + a registry name (pre-wire-name history) is that tool, unless the string is
    // itself registered; it never falls through to bash's advertised name.
    expect(invoke("mcp_pi_mcp_pi_bash", tools)[0]!.toolName).toBe(
      custom.includes("mcp_pi_mcp_pi_bash") ? "mcp_pi_mcp_pi_bash" : "mcp_pi_bash",
    );

    for (const [i, name] of registry.entries()) {
      if (!custom.includes(name)) continue;
      expect(localToolPolicyText(tools)).toContain(
        `call the custom tool "${name}" as ${advertised[i]}`,
      );
      expect(nativeToolRejectReason("shellArgs", tools)).toContain(advertised[i]);
    }
    expect(localToolPolicyText(piTools())).not.toContain("name clash");
    const history = JSON.stringify(
      buildRootPromptMessages(
        "",
        [
          {
            userText: "run all",
            steps: registry.map((toolName) => ({
              kind: "toolCall" as const,
              toolName,
              toolCallId: toolName,
              arguments: {},
            })),
          },
        ],
        availableToolNamesFor(tools),
      ),
    );
    registry.forEach((name, i) =>
      expect(history).toContain(`"toolCallId":"${name}","toolName":"${advertised[i]}"`),
    );
  });

  it("filters matching server IDs but falls back to all servers when none match", () => {
    const tools = [
      ...piTools(),
      create(McpToolDefinitionSchema, {
        ...piTools()[0]!,
        providerIdentifier: "other",
        name: "custom",
        toolName: "custom",
      }),
    ];
    expect(answerMcpState(["pi"], tools).map((server) => server.serverIdentifier)).toEqual(["pi"]);
    expect(answerMcpState(["other"], tools)[0]!.tools[0]!.toolName).toBe("custom");
    for (const ids of [[], ["custom-user-tools"], ["missing"]]) {
      expect(answerMcpState(ids, tools).map((server) => server.serverIdentifier)).toEqual([
        "pi",
        "other",
      ]);
    }
    expect(
      answerMcpState(["missing", "pi"], tools).map((server) => server.serverIdentifier),
    ).toEqual(["pi"]);
    expect(answerMcpState([], [])).toEqual([]);
  });

  it("never invents tools when the registry is empty", () => {
    expect(mcpStateServersFor([], ["custom-user-tools"])).toEqual([]);
  });
});
