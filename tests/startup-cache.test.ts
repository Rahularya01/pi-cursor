import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isRefreshKnownBad,
  markRefreshFailed,
  markRefreshSucceeded,
  resetRefreshGuardForTests,
} from "../src/auth/refresh-guard.js";
import {
  readCachedCatalog,
  resetCatalogCacheForTests,
  writeCachedCatalog,
} from "../src/stream/model-cache.js";
import { resetCacheDirForTests } from "../src/utils/cache-dir.js";
import type { CursorParameterizedModel } from "../src/client/cursor-wire.js";
import type { CursorModel } from "../src/stream/model-discovery.js";

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "pi-cursor-cache-test-"));
  process.env.PI_CURSOR_CACHE_DIR = cacheDir;
  resetCacheDirForTests();
  resetRefreshGuardForTests();
  resetCatalogCacheForTests();
});

afterEach(() => {
  delete process.env.PI_CURSOR_CACHE_DIR;
  resetCacheDirForTests();
  resetRefreshGuardForTests();
  resetCatalogCacheForTests();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("refresh guard", () => {
  it("suppresses retries for a token that just failed", () => {
    expect(isRefreshKnownBad("stale-token")).toBe(false);
    markRefreshFailed("stale-token");
    expect(isRefreshKnownBad("stale-token")).toBe(true);
    // Other tokens are unaffected.
    expect(isRefreshKnownBad("other-token")).toBe(false);
  });

  it("persists the back-off across processes", () => {
    markRefreshFailed("stale-token");
    // Simulate a fresh process: in-memory state gone, cache file remains.
    resetRefreshGuardForTests();
    expect(isRefreshKnownBad("stale-token")).toBe(true);
  });

  it("retries again once the entry expires", () => {
    markRefreshFailed("stale-token", -1);
    expect(isRefreshKnownBad("stale-token")).toBe(false);
  });

  it("clears the entry after a successful exchange", () => {
    markRefreshFailed("stale-token");
    markRefreshSucceeded("stale-token");
    expect(isRefreshKnownBad("stale-token")).toBe(false);
  });

  it("never writes the raw token to disk", () => {
    markRefreshFailed("super-secret-refresh-token");
    resetRefreshGuardForTests();
    const raw = readFileSync(join(cacheDir, "refresh-failures.json"), "utf8");
    expect(raw).not.toContain("super-secret-refresh-token");
  });
});

describe("model catalog cache", () => {
  const rawModels: CursorModel[] = [
    {
      id: "claude-4.5-opus",
      name: "Claude 4.5 Opus",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 64_000,
    },
  ];
  const parameterizedModels: CursorParameterizedModel[] = [
    {
      name: "claude-4.5-opus",
      variants: [{ parameters: [{ id: "effort", value: "high" }], isMaxMode: false }],
    },
  ];

  it("round-trips a discovered catalog", () => {
    writeCachedCatalog({ tokenHash: "abc123", rawModels, parameterizedModels });
    resetCatalogCacheForTests();
    const cached = readCachedCatalog();
    expect(cached?.rawModels).toHaveLength(1);
    expect(cached?.parameterizedModels).toHaveLength(1);
    expect(cached?.tokenHash).toBe("abc123");
  });

  it("returns undefined when nothing is cached", () => {
    expect(readCachedCatalog()).toBeUndefined();
  });

  it("ignores an empty catalog rather than caching a bad discovery", () => {
    writeCachedCatalog({ tokenHash: "abc123", rawModels: [], parameterizedModels: [] });
    resetCatalogCacheForTests();
    expect(readCachedCatalog()).toBeUndefined();
  });

  it("rejects a catalog written by an older cache version", () => {
    writeFileSync(
      join(cacheDir, "model-catalog.json"),
      JSON.stringify({
        version: 0,
        tokenHash: "x",
        savedAt: Date.now(),
        rawModels,
        parameterizedModels,
      }),
    );
    resetCatalogCacheForTests();
    expect(readCachedCatalog()).toBeUndefined();
  });

  it("rejects a catalog older than the max age", () => {
    writeFileSync(
      join(cacheDir, "model-catalog.json"),
      JSON.stringify({
        version: 1,
        tokenHash: "x",
        savedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
        rawModels,
        parameterizedModels,
      }),
    );
    resetCatalogCacheForTests();
    expect(readCachedCatalog()).toBeUndefined();
  });

  it("survives a corrupt cache file", () => {
    writeFileSync(join(cacheDir, "model-catalog.json"), "{not json");
    resetCatalogCacheForTests();
    expect(readCachedCatalog()).toBeUndefined();
  });
});
