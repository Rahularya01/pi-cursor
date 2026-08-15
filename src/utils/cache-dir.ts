/**
 * On-disk cache location for cross-process state (model catalog, refresh
 * back-off). Kept out of the pi config dir: everything here is derived data
 * that can be deleted at any time without losing user configuration.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

let cachedDir: string | undefined;

/** Resolve (and create) the cache directory. Returns undefined if unusable. */
export function getCacheDir(): string | undefined {
  if (cachedDir !== undefined) return cachedDir || undefined;
  const configured = process.env.PI_CURSOR_CACHE_DIR?.trim();
  const base =
    configured ||
    pathJoin(process.env.XDG_CACHE_HOME?.trim() || pathJoin(homedir(), ".cache"), "pi-cursor");
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    cachedDir = base;
    return base;
  } catch {
    // Read-only home / sandbox: callers fall back to in-memory only.
    cachedDir = "";
    return undefined;
  }
}

/** Absolute path for a cache file, or undefined when no cache dir is usable. */
export function cacheFilePath(name: string): string | undefined {
  const dir = getCacheDir();
  return dir ? pathJoin(dir, name) : undefined;
}

/** Test helper: forget the resolved directory between cases. */
export function resetCacheDirForTests(): void {
  cachedDir = undefined;
}
