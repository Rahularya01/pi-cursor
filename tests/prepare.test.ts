import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import {
  bunHomeBinDir,
  bunHomeBinary,
  bunVersionAtLeast,
  parseBunVersion,
  resolveExistingBun,
} from "../scripts/prepare.mjs";

describe("prepare Bun bootstrap", () => {
  it("parses bun --version output", () => {
    expect(parseBunVersion("1.4.0\n")).toEqual({ major: 1, minor: 4, patch: 0 });
    expect(parseBunVersion("1.3.9")).toEqual({ major: 1, minor: 3, patch: 9 });
    expect(parseBunVersion("not-a-version")).toBeNull();
  });

  it("requires Bun 1.4.0 or newer", () => {
    expect(bunVersionAtLeast({ major: 1, minor: 4, patch: 0 })).toBe(true);
    expect(bunVersionAtLeast({ major: 1, minor: 4, patch: 1 })).toBe(true);
    expect(bunVersionAtLeast({ major: 1, minor: 3, patch: 9 })).toBe(false);
    expect(bunVersionAtLeast({ major: 0, minor: 9, patch: 0 })).toBe(false);
  });

  it("resolves the default ~/.bun/bin location and BUN_INSTALL", () => {
    expect(bunHomeBinDir({}, "/tmp/home")).toBe(join("/tmp/home", ".bun", "bin"));
    expect(bunHomeBinDir({ BUN_INSTALL: "/opt/bun" }, "/tmp/home")).toBe(join("/opt/bun", "bin"));
    expect(bunHomeBinary({}, "/tmp/home")).toContain(".bun");
  });

  it("finds the bun already on PATH in this environment", () => {
    const resolved = resolveExistingBun();
    expect(resolved).not.toBeNull();
    expect(resolved?.command).toBeTruthy();
    expect(resolved && bunVersionAtLeast(resolved.version)).toBe(true);
  });
});
