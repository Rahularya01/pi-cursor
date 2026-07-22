import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
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
 */
export async function getCursorKeychainToken(): Promise<CursorTokenResult | undefined> {
  if (platform() !== "darwin") return undefined;

  let accessToken: string | undefined;
  let refreshToken: string | undefined;

  try {
    const rawAccess = execFileSync(
      "security",
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 },
    ).trim();
    if (rawAccess) accessToken = rawAccess;
  } catch {
    // Keychain item not found or error
  }

  try {
    const rawRefresh = execFileSync(
      "security",
      ["find-generic-password", "-s", "cursor-refresh-token", "-a", "cursor-user", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 },
    ).trim();
    if (rawRefresh) refreshToken = rawRefresh;
  } catch {
    // Keychain item not found or error
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

async function getDatabaseSync() {
  try {
    const mod = await import("node:sqlite");
    return mod.DatabaseSync;
  } catch {
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
 * 2. macOS Keychain (Cursor CLI)
 * 3. Cursor IDE state.vscdb
 */
export async function resolveSystemCursorAccessToken(): Promise<CursorTokenResult | undefined> {
  const envToken = getCursorAccessTokenFromEnv();
  if (envToken) return { accessToken: envToken, source: "env" };

  const keychainToken = await getCursorKeychainToken();
  if (keychainToken) return keychainToken;

  const vscdbToken = await getCursorVscdbToken();
  if (vscdbToken) return vscdbToken;

  return undefined;
}
