import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
import { systemCredentialsAllowed } from "./consent.js";
import { getCursorAccessTokenFromEnv, getTokenExpiry, refreshCursorToken } from "./oauth.js";

export type CredentialSource =
  | "env"
  | "cli_keychain"
  | "cli_keychain_refresh"
  | "ide_vscdb"
  | "ide_vscdb_refresh"
  | "pi_oauth"
  | "pi_oauth_refresh";

export interface CursorTokenResult {
  accessToken: string;
  source: CredentialSource;
}

/**
 * Reads token from macOS Keychain (security CLI).
 * Uses async execFile so Keychain reads don't block the event loop.
 */
export async function getCursorKeychainToken(): Promise<CursorTokenResult | undefined> {
  if (platform() !== "darwin") return undefined;

  let accessToken: string | undefined;
  let refreshToken: string | undefined;

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

  if (accessResult.status === "fulfilled") {
    const raw = accessResult.value.stdout.trim();
    if (raw) accessToken = raw;
  }
  if (refreshResult.status === "fulfilled") {
    const raw = refreshResult.value.stdout.trim();
    if (raw) refreshToken = raw;
  }

  if (accessToken && Date.now() < getTokenExpiry(accessToken)) {
    return { accessToken, source: "cli_keychain" };
  }

  if (refreshToken) {
    try {
      const refreshed = await refreshCursorToken(refreshToken);
      return { accessToken: refreshed.access, source: "cli_keychain_refresh" };
    } catch {
      // Refresh failed
    }
  }

  return undefined;
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

/**
 * Reads token from Cursor IDE state.vscdb.
 */
export async function getCursorVscdbToken(): Promise<CursorTokenResult | undefined> {
  const DatabaseSyncClass = await getDatabaseSync();
  if (!DatabaseSyncClass) return undefined;

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

  for (const dbPath of dbPaths) {
    try {
      const db = new DatabaseSyncClass(dbPath, { readOnly: true });

      const accessRow = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
        .get() as { value?: string } | undefined;
      const refreshRow = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/refreshToken'")
        .get() as { value?: string } | undefined;

      db.close();

      const accessToken = typeof accessRow?.value === "string" ? accessRow.value.trim() : undefined;
      const refreshToken =
        typeof refreshRow?.value === "string" ? refreshRow.value.trim() : undefined;

      if (accessToken && Date.now() < getTokenExpiry(accessToken)) {
        return { accessToken, source: "ide_vscdb" };
      }

      if (refreshToken) {
        try {
          const refreshed = await refreshCursorToken(refreshToken);
          return { accessToken: refreshed.access, source: "ide_vscdb_refresh" };
        } catch {
          // Refresh failed
        }
      }
    } catch {
      // Database missing or unreadable
    }
  }

  return undefined;
}

/**
 * Full credential resolution cascade:
 * 1. CURSOR_ACCESS_TOKEN env var
 * 2. macOS Keychain (Cursor CLI) — gated by system-credential consent
 * 3. Cursor IDE state.vscdb — gated by system-credential consent
 *
 * Opt out of Keychain/vscdb scraping with PI_CURSOR_SYSTEM_CREDENTIALS=0.
 */
export async function resolveSystemCursorAccessToken(options?: {
  forceRefresh?: boolean;
}): Promise<CursorTokenResult | undefined> {
  const envToken = getCursorAccessTokenFromEnv();
  if (envToken) {
    // Env tokens cannot be refreshed here; still prefer them when present.
    if (!options?.forceRefresh || Date.now() < getTokenExpiry(envToken)) {
      return { accessToken: envToken, source: "env" };
    }
  }

  if (!systemCredentialsAllowed()) {
    return undefined;
  }

  // forceRefresh: skip unexpired access-token short-circuit by re-reading sources
  // (keychain/vscdb helpers already refresh when access is expired).
  const keychainToken = await getCursorKeychainToken();
  if (keychainToken) {
    if (!options?.forceRefresh || keychainToken.source.endsWith("_refresh")) {
      return keychainToken;
    }
    // Access still valid but forceRefresh requested — try refresh path via re-read.
    // Keychain helper returns unexpired access first; force path falls through to vscdb/oauth.
  }

  const vscdbToken = await getCursorVscdbToken();
  if (vscdbToken) return vscdbToken;

  // If forceRefresh and we only had unexpired keychain access, return it as last resort.
  if (keychainToken) return keychainToken;

  return undefined;
}
