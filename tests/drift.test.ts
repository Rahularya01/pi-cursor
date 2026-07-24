import { beforeEach, describe, expect, it } from "vitest";
import {
  formatDriftSummary,
  getDriftSignals,
  hasStrandingDrift,
  recordDriftSignal,
  recordUnknownFields,
  resetDriftSignalsForTests,
} from "../src/stream/drift.js";
import { appendDriftDiagnostic, enhanceCursorStreamError } from "../src/stream/protocol.js";

beforeEach(() => {
  resetDriftSignalsForTests();
});

describe("drift signal recording", () => {
  it("starts clean", () => {
    expect(getDriftSignals()).toEqual([]);
    expect(formatDriftSummary()).toBe("");
    expect(hasStrandingDrift()).toBe(false);
  });

  it("counts repeat observations instead of duplicating them", () => {
    recordDriftSignal("server_message", "someNewCase");
    recordDriftSignal("server_message", "someNewCase");
    recordDriftSignal("server_message", "someNewCase");

    const signals = getDriftSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: "server_message", detail: "someNewCase", count: 3 });
  });

  it("treats an undefined case as 'unknown' rather than dropping it", () => {
    recordDriftSignal("server_message", undefined);
    expect(getDriftSignals()[0]?.detail).toBe("unknown");
  });

  it("distinguishes stranding cases from informational ones", () => {
    recordDriftSignal("unknown_fields", "ModelDetails#7");
    expect(hasStrandingDrift()).toBe(false);

    recordDriftSignal("exec_message", "someExecCase");
    expect(hasStrandingDrift()).toBe(true);
  });

  it("records unknown protobuf fields by field number", () => {
    recordUnknownFields("ModelDetails", { $unknown: [{ no: 9 }, { no: 4 }, { no: 9 }] });
    expect(getDriftSignals()[0]).toMatchObject({
      kind: "unknown_fields",
      detail: "ModelDetails#4,9",
    });
  });

  it("ignores messages with no unknown fields", () => {
    recordUnknownFields("ModelDetails", { $unknown: [] });
    recordUnknownFields("ModelDetails", {});
    recordUnknownFields("ModelDetails", null);
    expect(getDriftSignals()).toEqual([]);
  });

  it("summarizes the noisiest signals first and elides the tail", () => {
    recordDriftSignal("server_message", "a");
    recordDriftSignal("server_message", "a");
    recordDriftSignal("kv_message", "b");
    recordDriftSignal("exec_message", "c");
    recordDriftSignal("interaction_query", "d");
    recordDriftSignal("interaction_update", "e");

    const summary = formatDriftSummary(2);
    expect(summary).toContain("server_message:ax2");
    expect(summary).toContain("+3 more");
  });
});

describe("drift reporting in stream errors", () => {
  it("leaves messages untouched when nothing has drifted", () => {
    expect(appendDriftDiagnostic("boom")).toBe("boom");
    expect(enhanceCursorStreamError("boom")).toBe("boom");
  });

  it("names the unhandled case so a timeout is explainable", () => {
    recordDriftSignal("server_message", "brandNewCase");
    const message = enhanceCursorStreamError("Cursor stream idle timeout after 120000ms");

    expect(message).toContain("wire-drift");
    expect(message).toContain("server_message:brandNewCase");
    expect(message).toContain("the turn may have been left waiting on one");
  });

  it("describes unknown fields as a schema lag rather than a stall cause", () => {
    recordDriftSignal("unknown_fields", "ModelDetails#12");
    const message = appendDriftDiagnostic("something failed");

    expect(message).toContain("schema is likely behind Cursor");
    expect(message).not.toContain("left waiting");
  });

  it("still prefers the auth hint for auth failures", () => {
    recordDriftSignal("server_message", "brandNewCase");
    const message = enhanceCursorStreamError("unauthenticated: token expired");

    expect(message).toContain("auth-hint");
    expect(message).not.toContain("wire-drift");
  });
});
