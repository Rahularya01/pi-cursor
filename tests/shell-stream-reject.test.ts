import { afterEach, describe, expect, it } from "vitest";
import { create, fromBinary } from "@bufbuild/protobuf";

import { dispatchNativeExec, nativeShellStreamEnabled } from "../src/stream/exec-native.js";
import { __testInternals } from "../src/stream/server-messages.js";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  type McpToolDefinition,
  ShellArgsSchema,
} from "../src/proto/agent_pb.js";

const { handleExecMessageInner } = __testInternals;

const ENV_KEY = "PI_CURSOR_NATIVE_SHELL";
const previous = process.env[ENV_KEY];

afterEach(() => {
  if (previous === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previous;
});

function shellStreamMessage(command = "ls -la") {
  return create(ExecServerMessageSchema, {
    id: 7,
    execId: "exec-1",
    message: {
      case: "shellStreamArgs",
      value: create(ShellArgsSchema, { command, workingDirectory: "", toolCallId: "tool-1" }),
    },
  });
}

function bashTool(): McpToolDefinition {
  return { name: "bash", toolName: "bash", description: "run a command" } as McpToolDefinition;
}

/** Decode every frame the handler wrote back onto the stream. */
function captureFrames() {
  const frames: ReturnType<typeof fromBinary<typeof AgentClientMessageSchema>>[] = [];
  const sendFrame = (data: Uint8Array) => {
    // Strip the 5-byte Connect envelope (flags + big-endian length).
    frames.push(fromBinary(AgentClientMessageSchema, data.subarray(5)));
  };
  return { frames, sendFrame };
}

describe("native shell execution gate", () => {
  it("is off unless the environment opts in", () => {
    delete process.env[ENV_KEY];
    expect(nativeShellStreamEnabled()).toBe(false);
    expect(dispatchNativeExec("shellStreamArgs", { command: "ls" })).toBeUndefined();
  });

  it("runs in-process when PI_CURSOR_NATIVE_SHELL is set", () => {
    for (const value of ["1", "true"]) {
      process.env[ENV_KEY] = value;
      expect(nativeShellStreamEnabled()).toBe(true);
      expect(dispatchNativeExec("shellStreamArgs", { command: "ls" })?.kind).toBe("stream");
    }
  });

  it("leaves the other native exec cases alone", () => {
    delete process.env[ENV_KEY];
    expect(dispatchNativeExec("lsArgs", { path: "." })?.kind).toBe("sync");
    expect(dispatchNativeExec("fetchArgs", { url: "https://example.com" })?.kind).toBe("async");
  });
});

describe("shellStreamArgs rejection", () => {
  it("answers with one rejected frame pointing at Pi's bash tool", () => {
    delete process.env[ENV_KEY];
    const { frames, sendFrame } = captureFrames();

    const handled = handleExecMessageInner(
      shellStreamMessage("git status --short"),
      [bashTool()],
      sendFrame,
      () => {},
    );

    expect(handled).toBe(true);
    expect(frames).toHaveLength(1);
    const client = frames[0].message.value as any;
    expect(frames[0].message.case).toBe("execClientMessage");
    expect(client.id).toBe(7);
    expect(client.execId).toBe("exec-1");
    expect(client.message.case).toBe("shellStream");
    const event = client.message.value.event;
    expect(event.case).toBe("rejected");
    expect(event.value.command).toBe("git status --short");
    expect(event.value.reason).toContain('"bash"');
  });

  it("falls back to generic guidance when no bash tool is available", () => {
    delete process.env[ENV_KEY];
    const { frames, sendFrame } = captureFrames();

    handleExecMessageInner(shellStreamMessage(), [], sendFrame, () => {});

    const event = (frames[0].message.value as any).message.value.event;
    expect(event.case).toBe("rejected");
    expect(event.value.reason).toContain("Use the MCP tools provided instead");
  });

  it("does not reject once native execution is enabled", () => {
    process.env[ENV_KEY] = "1";
    const { frames, sendFrame } = captureFrames();
    const work: Promise<void>[] = [];

    const handled = handleExecMessageInner(
      shellStreamMessage("printf hi"),
      [bashTool()],
      sendFrame,
      () => {},
      (promise) => work.push(promise),
    );

    expect(handled).toBe(true);
    expect(work).toHaveLength(1);
    return work[0].then(() => {
      const events = frames.map((f) => (f.message.value as any).message.value.event.case);
      expect(events).toContain("start");
      expect(events).toContain("exit");
    });
  });
});
