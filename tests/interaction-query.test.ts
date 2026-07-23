import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  InteractionQuerySchema,
  WebSearchRequestQuerySchema,
  AskQuestionInteractionQuerySchema,
  AskQuestionArgsSchema,
} from "../src/proto/agent_pb.js";
import { handleInteractionQuery } from "../src/stream/interaction-query.js";

describe("handleInteractionQuery", () => {
  it("answers web search queries so the stream does not stall", () => {
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
    expect(result.action).toBe("web_search_approved");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.byteLength).toBeGreaterThan(5);
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

  it("approves unnamed web-fetch field #9", () => {
    const frames: Uint8Array[] = [];
    const query = create(InteractionQuerySchema, { id: 11 });
    (
      query as unknown as { $unknown: Array<{ no: number; wireType: number; data: Uint8Array }> }
    ).$unknown = [{ no: 9, wireType: 2, data: new Uint8Array([0x0a, 0x00]) }];
    const result = handleInteractionQuery(query, (frame) => frames.push(frame));
    expect(result.handled).toBe(true);
    expect(result.action).toBe("web_fetch_approved");
    expect(frames).toHaveLength(1);
  });
});
