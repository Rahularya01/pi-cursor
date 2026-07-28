/**
 * Cross-process cache of the discovered Cursor model catalog.
 *
 * The in-memory TTL cache in ./model-discovery.ts only helps within one pi
 * process; a fresh launch re-paid the full discovery round-trip (~4s, dominated
 * by a 150KB AvailableModels response) before the provider could be registered
 * at all. Persisting the raw discovery output lets startup register a
 * last-known-good catalog synchronously and refresh in the background.
 *
 * The raw shapes are stored rather than pi `ModelConfig` rows because the
 * effort/routing lookups that `streamSimple` depends on are derived from
 * `parameters`, `requestedModelId` and `requiresMaxMode`, none of which survive
 * the conversion to pi's model format.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { cacheFilePath } from "../utils/cache-dir.js";
import type { CursorParameterizedModel } from "../client/cursor-wire.js";
import type { CursorModel } from "./model-discovery.js";

const CACHE_FILE = "model-catalog.json";
const CACHE_VERSION = 1;

/** Discard a persisted catalog older than this rather than serving something ancient. */
export const CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CachedCatalog {
  version: number;
  /** Hash of the token the catalog was discovered with, for staleness reporting. */
  tokenHash: string;
  savedAt: number;
  rawModels: CursorModel[];
  parameterizedModels: CursorParameterizedModel[];
}

let memoized: CachedCatalog | null | undefined;

/**
 * Read the persisted catalog. Synchronous by design: extension activation must
 * be able to register models without awaiting anything.
 */
export function readCachedCatalog(): CachedCatalog | undefined {
  if (memoized !== undefined) return memoized ?? undefined;
  memoized = null;
  const path = cacheFilePath(CACHE_FILE);
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CachedCatalog>;
    if (
      parsed?.version !== CACHE_VERSION ||
      typeof parsed.savedAt !== "number" ||
      !Array.isArray(parsed.rawModels) ||
      !Array.isArray(parsed.parameterizedModels)
    ) {
      return undefined;
    }
    if (Date.now() - parsed.savedAt > CATALOG_MAX_AGE_MS) return undefined;
    if (parsed.rawModels.length === 0 && parsed.parameterizedModels.length === 0) return undefined;
    memoized = {
      version: CACHE_VERSION,
      tokenHash: typeof parsed.tokenHash === "string" ? parsed.tokenHash : "",
      savedAt: parsed.savedAt,
      rawModels: parsed.rawModels as CursorModel[],
      parameterizedModels: parsed.parameterizedModels as CursorParameterizedModel[],
    };
    return memoized;
  } catch {
    // Missing or corrupt cache falls back to the bundled catalog.
    return undefined;
  }
}

/** Persist a freshly discovered catalog. Never throws. */
export function writeCachedCatalog(entry: {
  tokenHash: string;
  rawModels: CursorModel[];
  parameterizedModels: CursorParameterizedModel[];
}): void {
  if (entry.rawModels.length === 0 && entry.parameterizedModels.length === 0) return;
  const catalog: CachedCatalog = {
    version: CACHE_VERSION,
    tokenHash: entry.tokenHash,
    savedAt: Date.now(),
    rawModels: entry.rawModels,
    parameterizedModels: entry.parameterizedModels,
  };
  memoized = catalog;
  const path = cacheFilePath(CACHE_FILE);
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(catalog), { mode: 0o600 });
  } catch {
    // Best effort: an unwritable cache only costs the next launch a refresh.
  }
}

/** Test helper: drop in-memory state so the next read hits disk again. */
export function resetCatalogCacheForTests(): void {
  memoized = undefined;
}
