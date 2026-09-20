import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  clipboardImagePathsInText,
  isPiClipboardImagePath,
  loadClipboardImagesFromText,
} from "../src/stream/clipboard-images.js";
import { parseMessages } from "../src/stream/message-parsing.js";

/** 1×1 PNG. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const CLIPBOARD_NAME = "pi-clipboard-8b8fd2d3-4b96-483a-8480-451974c41b55.png";

describe("clipboard image path allowlist", () => {
  it("accepts a Pi clipboard image under tmpdir", () => {
    const file = path.join(tmpdir(), CLIPBOARD_NAME);
    writeFileSync(file, PNG_1X1);
    try {
      expect(isPiClipboardImagePath(file)).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("rejects other temp files and workspace-looking names", () => {
    expect(isPiClipboardImagePath(path.join(tmpdir(), "evil.sh"))).toBe(false);
    expect(isPiClipboardImagePath(path.join(tmpdir(), "pi-clipboard-not-a-uuid.png"))).toBe(false);
    expect(isPiClipboardImagePath("/etc/passwd")).toBe(false);
  });
});

describe("clipboard paths in user text", () => {
  it("pulls the full path next to a prompt", () => {
    const file = path.join(tmpdir(), CLIPBOARD_NAME);
    expect(clipboardImagePathsInText(`${file} 请优化计数`)).toEqual([file]);
  });

  it("loads bytes for an existing clipboard image and skips missing ones", () => {
    const file = path.join(tmpdir(), CLIPBOARD_NAME);
    writeFileSync(file, PNG_1X1);
    try {
      const loaded = loadClipboardImagesFromText(`${file} please look`);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.mimeType).toBe("image/png");
      expect(loaded[0]?.data.byteLength).toBe(PNG_1X1.byteLength);
      expect(
        loadClipboardImagesFromText("/tmp/pi-clipboard-00000000-0000-0000-0000-000000000000.png"),
      ).toEqual([]);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("parseMessages clipboard ingest", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("attaches a Pi clipboard path as userImages", () => {
    const file = path.join(tmpdir(), CLIPBOARD_NAME);
    writeFileSync(file, PNG_1X1);
    try {
      const parsed = parseMessages([{ role: "user", content: `${file} 请优化计数` }]);
      expect(parsed.userText).toContain("请优化计数");
      expect(parsed.userImages).toHaveLength(1);
      expect(parsed.userImages[0]?.mimeType).toBe("image/png");
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("does not ingest a random image sitting in a temp workspace", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-ws-"));
    const decoy = path.join(dir, "screenshot.png");
    writeFileSync(decoy, PNG_1X1);
    const parsed = parseMessages([{ role: "user", content: decoy }]);
    expect(parsed.userImages).toHaveLength(0);
  });
});
