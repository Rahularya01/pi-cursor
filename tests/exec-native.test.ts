import { describe, expect, it } from "vitest";
import { dispatchNativeExec } from "../src/stream/exec-native.js";
import { rotateConversationAfterRateLimit } from "../src/stream/session-state.js";
import type { StoredConversation } from "../src/stream/types.js";

describe("native handlers", () => {
  it.each([
    "readArgs",
    "lsArgs",
    "grepArgs",
    "writeArgs",
    "deleteArgs",
    "shellArgs",
    "shellStreamArgs",
    "backgroundShellSpawnArgs",
    "writeShellStdinArgs",
  ])("does not execute %s", (name) => {
    expect(
      dispatchNativeExec(name, { path: "package.json", command: "echo unwanted" }),
    ).toBeUndefined();
  });
  it("retains diagnostics and resource discovery", () => {
    expect(dispatchNativeExec("diagnosticsArgs", {})?.kind).toBe("sync");
    expect(dispatchNativeExec("listMcpResourcesExecArgs", {})?.kind).toBe("sync");
  });
  it("retains fetch URL validation", async () => {
    const work = dispatchNativeExec("fetchArgs", { url: "file:///etc/passwd" });
    expect(work?.kind).toBe("async");
    if (work?.kind !== "async") return;
    expect((await work.run()).value).toMatchObject({
      result: { case: "error", value: { error: "Only http and https URLs can be fetched" } },
    });
  });
});

describe("conversation id rotation", () => {
  it("mints a new conversation id and drops the checkpoint", () => {
    const stored: StoredConversation = {
      conversationId: "old-id",
      checkpoint: new Uint8Array([1, 2, 3]),
      checkpointSource: "upstream",
      checkpointTurnCount: 1,
      checkpointHistoryFingerprint: "fp",
      sessionScoped: false,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
    };
    rotateConversationAfterRateLimit(stored);
    expect(stored.conversationId).not.toBe("old-id");
    expect(stored.checkpoint).toBeNull();
  });
});
