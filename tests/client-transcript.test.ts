import { describe, expect, it } from "vitest";
import {
  clientInFlightTurn,
  liveTranscript,
  recoveredTranscript,
  withSyntheticCurrentTurn,
} from "../src/stream/client-transcript.js";
import type { ParsedTurn } from "../src/stream/types.js";

function toolTurn(ids: string[], userText = "do work"): ParsedTurn {
  return {
    userText,
    steps: ids.map((toolCallId) => ({
      kind: "toolCall" as const,
      toolCallId,
      toolName: "bash",
      arguments: {},
    })),
  };
}

describe("client transcript", () => {
  it("live transcript is the wire current turn", () => {
    const completed: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const wire = toolTurn(["call-a"]);
    expect(clientInFlightTurn(liveTranscript(completed), wire)).toBe(wire);
  });

  it("recovered transcript prepends Pi's in-flight steps onto the synthetic wire turn", () => {
    const completed: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const piInFlight = toolTurn(["call-a", "call-b"]);
    const synthetic = toolTurn(["call-c"], "continue");
    const transcript = recoveredTranscript(completed, piInFlight);
    const merged = clientInFlightTurn(transcript, synthetic);
    expect(merged.steps.map((step) => (step.kind === "toolCall" ? step.toolCallId : ""))).toEqual([
      "call-a",
      "call-b",
      "call-c",
    ]);
  });

  it("withSyntheticCurrentTurn records the pre-recovery turn as Pi's in-flight", () => {
    const completed: ParsedTurn[] = [{ userText: "earlier", steps: [] }];
    const current = toolTurn(["call-a", "call-b"]);
    const recovered = withSyntheticCurrentTurn(liveTranscript(completed), current);
    expect(recovered.kind).toBe("recovered");
    if (recovered.kind === "recovered") {
      expect(recovered.completedTurns).toBe(completed);
      expect(recovered.inFlightTurn).toBe(current);
    }
  });
});
