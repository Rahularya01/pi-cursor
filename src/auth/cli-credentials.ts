import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
import { systemCredentialsAllowed } from "./consent.js";
import { getCursorAccessTokenFromEnv, getTokenExpiry, refreshCursorToken } from "./oauth.js";
import { isRefreshKnownBad, markRefreshFailed, markRefreshSucceeded } from "./refresh-guard.js";
import { CredentialSource } from "../types/enums.js";

export { CredentialSource };

export interface CursorTokenResult {
  accessToken: string;
  source: CredentialSource;
}

/** Raw token pair as stored by the Cursor CLI or IDE, before any validation. */
interface StoredTokens {
  accessToken?: string;
  refreshToken?: string;
}

function isUsable(token: string | undefined): token is string {
  if (!token) return false;
  try {
    return Date.now() < getTokenExpiry(token);
  } catch {
    return false;
  }
}

/**
 * Exchange a refresh token, honouring the failure back-off.
 *
 * Returns undefined without touching the network when this exact token failed
 * recently — a stale Cursor CLI entry otherwise costs seconds on every launch.
 */
async function tryRefresh(refreshToken: string | undefined): Promise<string | undefined> {
  if (!refreshToken || isRefreshKnownBad(refreshToken)) return undefined;
  try {
    const refreshed = await refreshCursorToken(refreshToken);
    markRefreshSucceeded(refreshToken);
    return refreshed.access;
  } catch {
    markRefreshFailed(refreshToken);
    return undefined;
  }
}

/** Reads the raw Cursor CLI token pair from the macOS Keychain. */
async function readKeychainTokens(): Promise<StoredTokens> {
  if (platform() !== "darwin") return {};

  // Run both Keychain lookups concurrently — they are independent reads.
  const [accessResult, refreshResult] = await Promise.allSettled([
    execFileAsync(
      "security",
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
      { encoding: "utf8", timeout: 2000 },
    ),
    execFileAsync(
      "security",
      ["find-generic-password", "-s", "cursor-refresh-token", "-a", "cursor-user", "-w"],
      { encoding: "utf8", timeout: 2000 },
    ),
  ]);

  const tokens: StoredTokens = {};
  if (accessResult.status === "fulfilled") {
    const raw = accessResult.value.stdout.trim();
    if (raw) tokens.accessToken = raw;
  }
  if (refreshResult.status === "fulfilled") {
    const raw = refreshResult.value.stdout.trim();
    if (raw) tokens.refreshToken = raw;
  }
  return tokens;
}

/**
 * Reads token from macOS Keychain (security CLI).
 * Uses async execFile so Keychain reads don't block the event loop.
 */
export async function getCursorKeychainToken(): Promise<CursorTokenResult | undefined> {
  const { accessToken, refreshToken } = await readKeychainTokens();
  if (isUsable(accessToken)) return { accessToken, source: CredentialSource.CliKeychain };
  const refreshed = await tryRefresh(refreshToken);
  return refreshed
    ? { accessToken: refreshed, source: CredentialSource.CliKeychainRefresh }
    : undefined;
}

// Cache the DatabaseSync constructor at module level so repeated vscdb lookups
// don't pay the dynamic-import cost each time.
let _databaseSyncCache:
  | (new (
      path: string,
      options?: { readOnly?: boolean },
    ) => { prepare(sql: string): { get(): unknown }; close(): void })
  | null
  | undefined = undefined;

async function getDatabaseSync() {
  if (_databaseSyncCache !== undefined) return _databaseSyncCache ?? undefined;
  try {
    const mod = await import("node:sqlite");
    _databaseSyncCache = mod.DatabaseSync as unknown as typeof _databaseSyncCache;
    return _databaseSyncCache ?? undefined;
  } catch {
    _databaseSyncCache = null;
    return undefined;
  }
}

/** Reads the raw Cursor IDE token pair from state.vscdb. */
async function readVscdbTokens(): Promise<StoredTokens> {
  const DatabaseSyncClass = await getDatabaseSync();
  if (!DatabaseSyncClass) return {};

  const dbPaths: string[] = [];
  const home = homedir();

  if (platform() === "darwin") {
    dbPaths.push(join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"));
  } else if (platform() === "win32") {
    if (process.env.APPDATA) {
      dbPaths.push(join(process.env.APPDATA, "Cursor/User/globalStorage/state.vscdb"));
    }
  } else {
    // Linux / WSL
    dbPaths.push(join(home, ".config/Cursor/User/globalStorage/state.vscdb"));
    // If running inside WSL, auto-detect Windows host Cursor credentials
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || existsSync("/mnt/c/Users")) {
      try {
        const usersDir = "/mnt/c/Users";
        if (existsSync(usersDir)) {
          for (const user of readdirSync(usersDir)) {
            if (user === "Public" || user === "Default" || user.startsWith(".")) continue;
            dbPaths.push(
              join(usersDir, user, "AppData/Roaming/Cursor/User/globalStorage/state.vscdb"),
            );
          }
        }
      } catch {
        // Ignore read permission errors on Windows user profiles
      }
    }
  }

  // Prefer the first profile that yields a usable access token; otherwise keep
  // the first refresh token seen so a single expired profile still has a path
  // back to a live session.
  const fallback: StoredTokens = {};
  for (const dbPath of dbPaths) {
    try {
      const db = new DatabaseSyncClass(dbPath, { readOnly: true });
      let accessRow: { value?: string } | undefined;
      let refreshRow: { value?: string } | undefined;
      try {
        accessRow = db
          .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
          .get() as { value?: string } | undefined;
        refreshRow = db
          .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/refreshToken'")
          .get() as { value?: string } | undefined;
      } finally {
        db.close();
      }

      const accessToken = typeof accessRow?.value === "string" ? accessRow.value.trim() : undefined;
      const refreshToken =
        typeof refreshRow?.value === "string" ? refreshRow.value.trim() : undefined;

      if (isUsable(accessToken)) return { accessToken, refreshToken };
      if (!fallback.refreshToken && refreshToken) fallback.refreshToken = refreshToken;
      if (!fallback.accessToken && accessToken) fallback.accessToken = accessToken;
    } catch {
      // Database missing or unreadable
    }
  }
  return fallback;
}

/**
 * Reads token from Cursor IDE state.vscdb.
 */
export async function getCursorVscdbToken(): Promise<CursorTokenResult | undefined> {
  const { accessToken, refreshToken } = await readVscdbTokens();
  if (isUsable(accessToken)) return { accessToken, source: CredentialSource.IdeVscdb };
  const refreshed = await tryRefresh(refreshToken);
  return refreshed
    ? { accessToken: refreshed, source: CredentialSource.IdeVscdbRefresh }
    : undefined;
}

/**
 * Full credential resolution cascade:
 * 1. CURSOR_ACCESS_TOKEN env var
 * 2. macOS Keychain (Cursor CLI) — gated by system-credential consent
 * 3. Cursor IDE state.vscdb — gated by system-credential consent
 *
 * Both system sources are read concurrently and every *local* token is checked
 * before any network exchange is attempted. That ordering matters: a stale CLI
 * keychain entry used to trigger a doomed ~2.6s refresh on the startup path
 * even though the IDE database held a valid token two milliseconds away.
 *
 * Opt out of Keychain/vscdb scraping with PI_CURSOR_SYSTEM_CREDENTIALS=0.
 */
export async function resolveSystemCursorAccessToken(options?: {
  forceRefresh?: boolean;
}): Promise<CursorTokenResult | undefined> {
  const envToken = getCursorAccessTokenFromEnv();
  if (envToken) {
    // Env tokens cannot be refreshed here; still prefer them when present.
    if (!options?.forceRefresh || isUsable(envToken)) {
      return { accessToken: envToken, source: CredentialSource.Env };
    }
  }

  if (!systemCredentialsAllowed()) {
    return undefined;
  }

  const [keychain, vscdb] = await Promise.all([readKeychainTokens(), readVscdbTokens()]);

  const cached: CursorTokenResult | undefined = isUsable(keychain.accessToken)
    ? { accessToken: keychain.accessToken, source: CredentialSource.CliKeychain }
    : isUsable(vscdb.accessToken)
      ? { accessToken: vscdb.accessToken, source: CredentialSource.IdeVscdb }
      : undefined;

  // Fast path: a locally stored token is still valid, so no network at all.
  if (cached && !options?.forceRefresh) return cached;

  const keychainRefreshed = await tryRefresh(keychain.refreshToken);
  if (keychainRefreshed) {
    return { accessToken: keychainRefreshed, source: CredentialSource.CliKeychainRefresh };
  }

  // Skip a second identical exchange when the CLI mirrored its token into the IDE.
  if (vscdb.refreshToken && vscdb.refreshToken !== keychain.refreshToken) {
    const vscdbRefreshed = await tryRefresh(vscdb.refreshToken);
    if (vscdbRefreshed)
      return { accessToken: vscdbRefreshed, source: CredentialSource.IdeVscdbRefresh };
  }

  // forceRefresh could not improve on what we already had — keep it rather than
  // reporting "not logged in" for a token that is still valid.
  return cached;
}
