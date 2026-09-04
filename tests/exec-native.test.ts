import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  dispatchNativeExec,
  emptyGrepPatternRejection,
  resolveInWorkspace,
} from "../src/stream/exec-native.js";
import { rotateConversationAfterRateLimit } from "../src/stream/session-state.js";
import type { StoredConversation } from "../src/stream/types.js";

describe("native exec workspace paths", () => {
  it("rejects paths that escape the workspace", () => {
    const resolved = resolveInWorkspace("../outside");
    expect("error" in resolved).toBe(true);
  });

  it("allows the workspace root and relative files", () => {
    expect("path" in resolveInWorkspace(".")).toBe(true);
    expect("path" in resolveInWorkspace("package.json")).toBe(true);
  });
});

describe("native exec handlers", () => {
  const prevCwd = process.cwd();
  let dir: string;

  afterEach(() => {
    process.chdir(prevCwd);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads a workspace file on the exec channel", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    writeFileSync(path.join(dir, "note.md"), "hello from native read\nsecond line\n");
    process.chdir(dir);
    const dispatched = dispatchNativeExec("readArgs", { path: "note.md", offset: 1, limit: 1 });
    expect(dispatched?.kind).toBe("sync");
    if (dispatched?.kind !== "sync") return;
    const result = (
      dispatched.frame.value as { result: { case: string; value: { output?: { value?: string } } } }
    ).result;
    expect(result.case).toBe("success");
    expect(result.value.output?.value).toContain("hello from native read");
  });

  it("writes then lists a directory", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    process.chdir(dir);
    const write = dispatchNativeExec("writeArgs", {
      path: "src/a.ts",
      fileText: "export const a = 1;\n",
    });
    expect(write?.kind).toBe("sync");
    if (write?.kind !== "sync") return;
    expect((write.frame.value as { result: { case: string } }).result.case).toBe("success");
    const ls = dispatchNativeExec("lsArgs", { path: "src" });
    expect(ls?.kind).toBe("sync");
    if (ls?.kind !== "sync") return;
    expect((ls.frame.value as { result: { case: string } }).result.case).toBe("success");
  });

  it("greps workspace files and rejects an empty pattern", () => {
    expect(emptyGrepPatternRejection("", "*.ts")).toMatch(/empty/);
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src/a.ts"), "const needle = 1;\n");
    process.chdir(dir);
    const grep = dispatchNativeExec("grepArgs", { pattern: "needle", path: "." });
    expect(grep?.kind).toBe("sync");
    if (grep?.kind !== "sync") return;
    expect((grep.frame.value as { result: { case: string } }).result.case).toBe("success");
  });

  it("runs a shell command inside the workspace", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    process.chdir(dir);
    const dispatched = dispatchNativeExec("shellArgs", {
      command: "echo native-shell",
      workingDirectory: ".",
    });
    expect(dispatched?.kind).toBe("async");
    if (dispatched?.kind !== "async") return;
    const frame = await dispatched.run();
    expect(
      (frame.value as { result: { case: string; value: { stdout?: string } } }).result.case,
    ).toBe("success");
    expect(
      (frame.value as { result: { value: { stdout?: string } } }).result.value.stdout,
    ).toContain("native-shell");
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
