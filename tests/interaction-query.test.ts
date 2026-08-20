import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  InteractionQuerySchema,
  WebSearchRequestQuerySchema,
  AskQuestionInteractionQuerySchema,
  AskQuestionArgsSchema,
  SwitchModeRequestQuerySchema,
} from "../src/proto/agent_pb.js";
import { handleInteractionQuery } from "../src/stream/interaction-query.js";

describe("handleInteractionQuery", () => {
  it("rejects web search by default so Cursor-side fetches do not run", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, {
      id: 7,
      query: {
        case: "webSearchRequestQuery",
        value: create(WebSearchRequestQuerySchema, {}),
      },
    });
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("web_search_rejected");
    expect(frames).toHaveLength(1);
  });

  it("still answers web search when explicitly approved", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, {
      id: 8,
      query: {
        case: "webSearchRequestQuery",
        value: create(WebSearchRequestQuerySchema, {}),
      },
    });
    const result = handleInteractionQuery(query, (frame) => frames.push(frame), {
      approveWeb: true,
    });
    expect(result.handled).toBe(true);
    expect(result.action).toBe("web_search_approved");
    expect(frames).toHaveLength(1);
  });

  it("rejects Cursor mode switches", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, {
      id: 4,
      query: {
        case: "switchModeRequestQuery",
        value: create(SwitchModeRequestQuerySchema, {}),
      },
    });
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("switch_mode_rejected");
    expect(frames).toHaveLength(1);
  });

  it("skips ask-question interactions instead of hanging", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, {
      id: 3,
      query: {
        case: "askQuestionInteractionQuery",
        value: create(AskQuestionInteractionQuerySchema, {
          args: create(AskQuestionArgsSchema, {}),
        }),
      },
    });
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("ask_question_skipped");
    expect(frames).toHaveLength(1);
  });

  it("rejects unnamed proto field #9 without killing the turn", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, { id: 11 });
    (
      query as unknown as { $unknown: Array<{ no: number; wireType: number; data: Uint8Array }> }
    ).$unknown = [{ no: 9, wireType: 2, data: new Uint8Array([0x0a, 0x00]) }];
    const result = handleInteractionQuery(query, (frame) => frames.push(frame), {
      approveWeb: true,
    });
    expect(result.handled).toBe(true);
    expect(result.action).toBe("unknown_field_9_rejected");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.byteLength).toBeGreaterThan(5);
  });

  it("fails closed for unknown future interaction fields", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, { id: 13 });
    (
      query as unknown as { $unknown: Array<{ no: number; wireType: number; data: Uint8Array }> }
    ).$unknown = [{ no: 99, wireType: 2, data: new Uint8Array() }];
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result).toMatchObject({ handled: false, action: "unknown_field_99_rejected" });
    expect(frames).toHaveLength(0);
  });
});
