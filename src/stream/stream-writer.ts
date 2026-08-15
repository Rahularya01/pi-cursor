/**
 * Stream writer adapter converting internal events to Pi AssistantMessageEventStream.
 */

import type { Api, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { NativeBlockKind, NativeStreamWriter, PendingExec, StreamState } from "./types.js";
import { applyCursorUsage, createCursorAssistantMessage } from "./pi-adapter.js";
import { parseToolCallArguments } from "./message-parsing.js";

export function createNativeStreamWriter(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
): NativeStreamWriter {
  const output = createCursorAssistantMessage(model);
  let started = false;
  let closed = false;
  let active: { kind: NativeBlockKind; contentIndex: number; ended: boolean } | undefined;

  const ensureStarted = (): void => {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial: output });
  };

  const endActiveBlock = (): void => {
    if (!active || active.ended) return;
    const block = output.content[active.contentIndex];
    if (active.kind === "text" && block?.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: active.contentIndex,
        content: block.text,
        partial: output,
      });
    } else if (active.kind === "thinking" && block?.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: active.contentIndex,
        content: block.thinking,
        partial: output,
      });
    }
    active.ended = true;
    active = undefined;
  };

  const ensureBlock = (kind: NativeBlockKind): number => {
    ensureStarted();
    if (active?.kind === kind && !active.ended) return active.contentIndex;
    endActiveBlock();
    const contentIndex = output.content.length;
    if (kind === "text") {
      output.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex, partial: output });
    } else {
      output.content.push({ type: "thinking", thinking: "" });
      stream.push({ type: "thinking_start", contentIndex, partial: output });
    }
    active = { kind, contentIndex, ended: false };
    return contentIndex;
  };

  return {
    output,
    get closed() {
      return closed;
    },
    start: ensureStarted,
    text(delta: string) {
      if (closed || !delta) return;
      const contentIndex = ensureBlock("text");
      const block = output.content[contentIndex];
      if (block?.type !== "text") return;
      block.text += delta;
      stream.push({ type: "text_delta", contentIndex, delta, partial: output });
    },
    thinking(delta: string) {
      if (closed || !delta) return;
      const contentIndex = ensureBlock("thinking");
      const block = output.content[contentIndex];
      if (block?.type !== "thinking") return;
      block.thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
    },
    toolCall(exec: PendingExec) {
      if (closed) return;
      ensureStarted();
      endActiveBlock();
      const contentIndex = output.content.length;
      const parsedArguments = parseToolCallArguments(exec.decodedArgs);
      const block = {
        type: "toolCall" as const,
        id: exec.toolCallId,
        name: exec.toolName,
        arguments: {},
      };
      output.content.push(block);
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      block.arguments = parsedArguments;
      stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta: exec.decodedArgs,
        partial: output,
      });
      stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: {
          type: "toolCall",
          id: exec.toolCallId,
          name: exec.toolName,
          arguments: parsedArguments,
        },
        partial: output,
      });
    },
    done(reason: "stop" | "length" | "toolUse", state?: StreamState) {
      if (closed) return;
      ensureStarted();
      endActiveBlock();
      applyCursorUsage(output, model, state);
      output.stopReason = reason;
      stream.push({ type: "done", reason, message: output });
      closed = true;
      stream.end(output);
    },
    error(message: string, reason: "error" | "aborted", state?: StreamState) {
      if (closed) return;
      ensureStarted();
      endActiveBlock();
      applyCursorUsage(output, model, state);
      output.stopReason = reason;
      output.errorMessage = message;
      stream.push({ type: "error", reason, error: output });
      closed = true;
      stream.end(output);
    },
  };
}
