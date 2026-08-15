/**
 * Extension authentication and startup token resolution.
 */

import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { getTokenExpiry, refreshCursorToken } from "../auth/oauth.js";
import { resolveSystemCursorAccessToken } from "../auth/cli-credentials.js";
import { CredentialSource, ProviderConstant } from "../types/enums.js";

export interface ResolvedAccessToken {
  accessToken: string;
  source: CredentialSource;
}

export async function getStoredCursorOAuthAccessToken(): Promise<ResolvedAccessToken | undefined> {
  const credential = readStoredCredential(ProviderConstant.ProviderId);
  if (!credential || credential.type !== "oauth") return undefined;

  if (Date.now() < credential.expires && credential.access) {
    return { accessToken: credential.access, source: CredentialSource.PiOAuth };
  }

  // Refresh is handled by Pi's OAuth runtime on demand; avoid writing auth.json here.
  if (credential.refresh) {
    try {
      const refreshed = await refreshCursorToken(credential.refresh);
      return { accessToken: refreshed.access, source: CredentialSource.PiOAuthRefresh };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function getStartupCursorAccessToken(options?: {
  forceRefresh?: boolean;
}): Promise<ResolvedAccessToken | undefined> {
  const systemToken = await resolveSystemCursorAccessToken(options);
  if (systemToken) return systemToken;
  return getStoredCursorOAuthAccessToken();
}

export function isTokenNearExpiry(token: string, skewMs = 60_000): boolean {
  try {
    return Date.now() >= getTokenExpiry(token) - skewMs;
  } catch {
    return true;
  }
}
