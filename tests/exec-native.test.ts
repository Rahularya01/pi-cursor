import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("allows read-only access to Pi clipboard images in tmpdir", () => {
    const name = "pi-clipboard-d41cbdb9-fc79-4558-a98a-d8f5a0af0114.png";
    const file = path.join(tmpdir(), name);
    writeFileSync(file, "not-an-image");
    try {
      expect("path" in resolveInWorkspace(file)).toBe(false);
      expect("path" in resolveInWorkspace(file, { allowTmpClipboardRead: true })).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
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

  it("reads a Pi clipboard PNG as image bytes instead of denying the path", () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const name = "pi-clipboard-11111111-2222-3333-4444-555555555555.png";
    const file = path.join(tmpdir(), name);
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    writeFileSync(file, png);
    try {
      process.chdir(dir);
      const write = dispatchNativeExec("writeArgs", { path: file, fileText: "nope" });
      expect(write?.kind).toBe("sync");
      if (write?.kind === "sync") {
        expect((write.frame.value as { result: { case: string } }).result.case).toBe(
          "permissionDenied",
        );
      }
      const dispatched = dispatchNativeExec("readArgs", { path: file });
      expect(dispatched?.kind).toBe("sync");
      if (dispatched?.kind !== "sync") return;
      const result = (
        dispatched.frame.value as {
          result: { case: string; value: { output?: { case?: string; value?: Uint8Array } } };
        }
      ).result;
      expect(result.case).toBe("success");
      expect(result.value.output?.case).toBe("data");
      expect(Buffer.from(result.value.output?.value ?? []).equals(png)).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("refuses a clipboard-named non-image instead of dumping UTF-8", () => {
    const name = "pi-clipboard-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
    const file = path.join(tmpdir(), name);
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    writeFileSync(file, "not-an-image");
    try {
      process.chdir(dir);
      const dispatched = dispatchNativeExec("readArgs", { path: file });
      expect(dispatched?.kind).toBe("sync");
      if (dispatched?.kind !== "sync") return;
      const result = (dispatched.frame.value as { result: { case: string } }).result;
      expect(result.case).toBe("error");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("refuses a clipboard-named symlink even when the target is in tmpdir", () => {
    const target = path.join(tmpdir(), "pi-cursor-secret.txt");
    const name = "pi-clipboard-ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb.png";
    const file = path.join(tmpdir(), name);
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    writeFileSync(target, "secret");
    try {
      symlinkSync(target, file);
      process.chdir(dir);
      expect("path" in resolveInWorkspace(file, { allowTmpClipboardRead: true })).toBe(false);
      const dispatched = dispatchNativeExec("readArgs", { path: file });
      expect(dispatched?.kind).toBe("sync");
      if (dispatched?.kind !== "sync") return;
      const result = (dispatched.frame.value as { result: { case: string } }).result;
      expect(result.case).toBe("permissionDenied");
    } finally {
      rmSync(file, { force: true });
      rmSync(target, { force: true });
    }
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
