import { cursorEnv } from "./util.js";

const ALLOWED_HOST_SUFFIXES = [".cursor.sh", ".cursor.com"];
const ALLOWED_HOSTS = new Set([
  "cursor.sh",
  "cursor.com",
  "api2.cursor.sh",
  "authenticator.cursor.sh",
]);

/** Prevent token exfiltration via poisoned agent URL. */
export function assertSafeCursorBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid Cursor agent URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Cursor agent URL must use http(s) (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error("Cursor agent URL must not include credentials");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    ALLOWED_HOSTS.has(host) ||
    ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    host === "localhost" ||
    host === "127.0.0.1";
  if (!allowed) {
    throw new Error(
      `Cursor agent URL host "${host}" is not allowed. Use a *.cursor.sh / *.cursor.com endpoint.`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

/** Redact JWTs, bearer tokens, and common secret keys from diagnostics/errors. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /("?(?:access_token|refresh_token|accessToken|refreshToken|token|authorization|code_verifier)"?\s*[:=]\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /("?(?:access_token|refresh_token|accessToken|refreshToken|token|authorization|code_verifier)"?\s*[:=]\s*)[^\s&,}]+/gi,
      "$1[redacted]",
    );
}

export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw);
}

export function debugEnabled(): boolean {
  const raw = (cursorEnv("DEBUG") || process.env.PI_CURSOR_PROVIDER_DEBUG || "")
    .trim()
    .toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}
