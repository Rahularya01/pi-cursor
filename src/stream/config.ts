/**
 * Cursor agent URL resolution (env → CLI config → default).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { assertSafeCursorBaseUrl } from "../utils/security.js";

export const DEFAULT_CURSOR_AGENT_URL = "https://agentn.us.api5.cursor.sh";
export const DEFAULT_CURSOR_CLIENT_VERSION = "cli-2026.05.01-eea359f";

let cachedCursorAgentUrl: string | undefined;

export function normalizeCursorUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function readCursorCliAgentUrl(): string | undefined {
  const configDir = process.env.CURSOR_CONFIG_DIR?.trim() || pathJoin(homedir(), ".cursor");
  try {
    const config = JSON.parse(readFileSync(pathJoin(configDir, "cli-config.json"), "utf8")) as {
      serverConfigCache?: {
        agentUrlConfig?: { agentnUrl?: unknown; agentUrl?: unknown };
      };
    };
    return (
      normalizeCursorUrl(config.serverConfigCache?.agentUrlConfig?.agentnUrl) ??
      normalizeCursorUrl(config.serverConfigCache?.agentUrlConfig?.agentUrl)
    );
  } catch {
    return undefined;
  }
}

export function getCursorClientVersion(): string {
  return process.env.PI_CURSOR_CLIENT_VERSION?.trim() || DEFAULT_CURSOR_CLIENT_VERSION;
}

/** Resolve the agent base URL, validating host against the allowlist. */
export function getCursorAgentUrl(): string {
  const envUrl =
    normalizeCursorUrl(process.env.PI_CURSOR_AGENT_URL) ??
    normalizeCursorUrl(process.env.CURSOR_AGENT_URL);
  if (envUrl) {
    cachedCursorAgentUrl = assertSafeCursorBaseUrl(envUrl);
    return cachedCursorAgentUrl;
  }
  if (cachedCursorAgentUrl) return cachedCursorAgentUrl;
  const resolved = readCursorCliAgentUrl() ?? DEFAULT_CURSOR_AGENT_URL;
  cachedCursorAgentUrl = assertSafeCursorBaseUrl(resolved);
  return cachedCursorAgentUrl;
}

/** Test helper: clear cached URL between cases. */
export function resetCursorAgentUrlCacheForTests(): void {
  cachedCursorAgentUrl = undefined;
}
