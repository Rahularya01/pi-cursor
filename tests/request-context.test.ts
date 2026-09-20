import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  RequestContextArgsSchema,
  type ExecClientMessage,
  type RequestContextResult,
  type RequestContextSuccess,
} from "../src/proto/agent_pb.js";
import { processServerMessage } from "../src/stream/server-messages.js";
import type { StreamState } from "../src/stream/types.js";

describe("requestContextArgs reply", () => {
  it("declares the current cwd as the workspace so Cursor doesn't diff it against the checkpoint's previousWorkspaceUris", () => {
    const message = create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: 1,
          execId: "exec-1",
          message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
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
        new Map(),
        [],
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
    expect(exec.message.case).toBe("requestContextResult");
    const result = exec.message.value as RequestContextResult;
    expect(result.result.case).toBe("success");
    const success = result.result.value as RequestContextSuccess;
    expect(success.requestContext?.env?.workspacePaths).toEqual([
      pathToFileURL(process.cwd()).href,
    ]);
  });
});
