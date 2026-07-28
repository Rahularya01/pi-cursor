/**
 * Back-off for Cursor refresh-token exchanges that are known to fail.
 *
 * The Cursor CLI can leave a stale keychain entry behind — in the observed
 * case it writes the *same expired access token* into `cursor-refresh-token`,
 * so `exchange_user_api_key` answers `Invalid User API Key` in ~2.6s. Without
 * a memory of that failure every pi launch re-pays those seconds on the
 * startup path before falling through to a source that works.
 *
 * Failures are keyed by a hash of the refresh token (never the token itself)
 * and persisted so the back-off survives process restarts. A token that starts
 * working again is picked up as soon as the entry expires, and any successful
 * exchange clears the entry immediately.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { cacheFilePath } from "../utils/cache-dir.js";

/** How long a failed exchange suppresses retries for the same token. */
export const REFRESH_FAILURE_TTL_MS = 10 * 60 * 1000;

const CACHE_FILE = "refresh-failures.json";

type FailureMap = Record<string, number>;

let failures: FailureMap | undefined;

function tokenKey(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
}

function load(): FailureMap {
  if (failures) return failures;
  failures = {};
  const path = cacheFilePath(CACHE_FILE);
  if (!path) return failures;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const now = Date.now();
      for (const [key, expiresAt] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof expiresAt === "number" && expiresAt > now) failures[key] = expiresAt;
      }
    }
  } catch {
    // Missing or corrupt cache is equivalent to "nothing known to be failing".
  }
  return failures;
}

function persist(map: FailureMap): void {
  const path = cacheFilePath(CACHE_FILE);
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(map), { mode: 0o600 });
  } catch {
    // Best effort: an unwritable cache only costs us the cross-process benefit.
  }
}

/** True when this refresh token failed recently and should not be retried yet. */
export function isRefreshKnownBad(refreshToken: string): boolean {
  const map = load();
  const expiresAt = map[tokenKey(refreshToken)];
  if (expiresAt === undefined) return false;
  if (Date.now() >= expiresAt) {
    delete map[tokenKey(refreshToken)];
    persist(map);
    return false;
  }
  return true;
}

/** Record a failed exchange so the next launch skips it. */
export function markRefreshFailed(refreshToken: string, ttlMs = REFRESH_FAILURE_TTL_MS): void {
  const map = load();
  map[tokenKey(refreshToken)] = Date.now() + ttlMs;
  persist(map);
}

/** Clear a recorded failure after a successful exchange. */
export function markRefreshSucceeded(refreshToken: string): void {
  const map = load();
  if (map[tokenKey(refreshToken)] === undefined) return;
  delete map[tokenKey(refreshToken)];
  persist(map);
}

/** Test helper: drop in-memory state so the next call re-reads from disk. */
export function resetRefreshGuardForTests(): void {
  failures = undefined;
}
