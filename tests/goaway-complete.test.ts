import { describe, expect, it } from "vitest";
import { canCompleteAfterGoaway, interactionUpdateCountsAsProgress } from "../src/stream/tuning.js";
import { isRetriableGoawayMessage } from "../src/stream/protocol.js";

describe("GOAWAY after turnEnded", () => {
  it("treats turnEnded and stepCompleted as idle-watchdog progress", () => {
    expect(interactionUpdateCountsAsProgress("turnEnded")).toBe(true);
    expect(interactionUpdateCountsAsProgress("stepCompleted")).toBe(true);
    expect(interactionUpdateCountsAsProgress("stepStarted")).toBe(true);
  });

  it("recognizes Cursor's retriable GOAWAY connect error", () => {
    expect(
      isRetriableGoawayMessage(
        "Connect error unavailable: Cursor GOAWAY (errorCode=0): upstream connection closed, retriable",
      ),
    ).toBe(true);
    expect(isRetriableGoawayMessage("Connect error unavailable: boom")).toBe(false);
    expect(isRetriableGoawayMessage("Bridge connection lost")).toBe(false);
  });

  it("completes only after turnEnded and outside a tool pause", () => {
    expect(canCompleteAfterGoaway({ sawTurnEnded: true, mcpExecReceived: false })).toBe(true);
    expect(canCompleteAfterGoaway({ sawTurnEnded: true, mcpExecReceived: true })).toBe(false);
    expect(canCompleteAfterGoaway({ sawTurnEnded: false, mcpExecReceived: false })).toBe(false);
  });
});
