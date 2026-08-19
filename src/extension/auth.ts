/**
 * Extension authentication and startup token resolution.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  getCursorAccessTokenFromEnv,
  getTokenExpiry,
  refreshCursorToken,
  type CursorCredentials,
} from "../auth/oauth.js";
import { resolveSystemCursorAccessToken } from "../auth/cli-credentials.js";
import { CredentialSource, ProviderConstant } from "../types/enums.js";

export interface ResolvedAccessToken {
  accessToken: string;
  source: CredentialSource;
}

function isUsableAccessToken(token: string): boolean {
  try {
    return Date.now() < getTokenExpiry(token);
  } catch {
    return false;
  }
}

/** Best-effort write of a rotated OAuth pair back into Pi's auth.json. */
export function persistRefreshedPiOAuth(credentials: CursorCredentials): void {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const data = parsed as Record<string, unknown>;
    const existing = data[ProviderConstant.ProviderId];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) return;
    data[ProviderConstant.ProviderId] = {
      ...(existing as Record<string, unknown>),
      type: "oauth",
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
    };
    writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // The process still has a usable access token; next launch may need /login.
  }
}

export async function getStoredCursorOAuthAccessToken(options?: {
  forceRefresh?: boolean;
}): Promise<ResolvedAccessToken | undefined> {
  const credential = readStoredCredential(ProviderConstant.ProviderId);
  if (!credential || credential.type !== "oauth") return undefined;

  if (!options?.forceRefresh && credential.access && Date.now() < credential.expires) {
    return { accessToken: credential.access, source: CredentialSource.PiOAuth };
  }

  if (credential.refresh) {
    try {
      const refreshed = await refreshCursorToken(credential.refresh);
      persistRefreshedPiOAuth(refreshed);
      return { accessToken: refreshed.access, source: CredentialSource.PiOAuthRefresh };
    } catch {
      if (credential.access && Date.now() < credential.expires) {
        return { accessToken: credential.access, source: CredentialSource.PiOAuth };
      }
      return undefined;
    }
  }
  return undefined;
}

export async function getStartupCursorAccessToken(options?: {
  forceRefresh?: boolean;
}): Promise<ResolvedAccessToken | undefined> {
  const envToken = getCursorAccessTokenFromEnv();
  if (envToken && (!options?.forceRefresh || isUsableAccessToken(envToken))) {
    return { accessToken: envToken, source: CredentialSource.Env };
  }

  // Explicit `/login cursor` must win over IDE/CLI harvest so the user is not
  // silently billed to a different Cursor account.
  const oauth = await getStoredCursorOAuthAccessToken(options);
  if (oauth) return oauth;

  return resolveSystemCursorAccessToken(options);
}

export function isTokenNearExpiry(token: string, skewMs = 60_000): boolean {
  try {
    return Date.now() >= getTokenExpiry(token) - skewMs;
  } catch {
    return true;
  }
}
