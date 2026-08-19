/**
 * Diagnostics sinks for the stream runtime.
 *
 * Three separate channels, deliberately:
 *   - `debugLog`     verbose JSONL, opt-in via PI_CURSOR_PROVIDER_DEBUG
 *   - `lifecycleLog` always-on compact log for diagnosing multi-minute stalls
 *   - `emitMetric`   structured counters, redirectable in tests
 *
 * Everything here swallows its own errors: diagnostics must never break a turn.
 * Payloads pass through `sanitizeForDebug`, which truncates strings, summarizes
 * binary/image data, and redacts access tokens.
 */
import { createHash } from "node:crypto";
import { appendFile } from "node:fs";
import { join as pathJoin } from "node:path";

import { getCacheDir } from "../utils/cache-dir.js";
import { redactSecrets } from "../utils/security.js";
import { normalizeImageMimeType } from "./images.js";
import type { CursorRequestDebugSummary } from "./types.js";

let debugRequestCounter = 0;

let debugLogFilePath: string | undefined;

export const requestDebugByBody = new WeakMap<Uint8Array, CursorRequestDebugSummary>();

// `debugLog` guards every call site on this, including one per server message on the streaming
// hot path. `process.env` is a native-backed proxy whose property reads cost ~100x an ordinary
// one, so resolve the flag once instead of on every token. Resolution stays lazy so a value pi
// exports after this module loads is still picked up.
let streamDebugEnabled: boolean | undefined;

export function isStreamDebugEnabled(): boolean {
  if (streamDebugEnabled === undefined) {
    const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
    streamDebugEnabled = !!raw && raw !== "0" && raw !== "false" && raw !== "off";
  }
  return streamDebugEnabled;
}

/** Test seam: re-read PI_CURSOR_PROVIDER_DEBUG after mutating process.env. */
export function resetStreamDebugForTests(): void {
  streamDebugEnabled = undefined;
}

export function truncateDebugString(value: string, max = 4000): string {
  return value.length > max
    ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>`
    : value;
}

export function debugByteSummary(bytes: Uint8Array): { byteLength: number; sha256: string } {
  return {
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  };
}

export function debugBase64ImageSummary(data: string): {
  base64Length: number;
  byteLength?: number;
  sha256?: string;
  decodeError?: boolean;
} {
  const stripped = data.replace(/\s/g, "");
  const bytes = Buffer.from(stripped, "base64");
  if (bytes.length > 0) {
    return { base64Length: data.length, ...debugByteSummary(new Uint8Array(bytes)) };
  }
  if (stripped.length > 0) {
    return { base64Length: data.length, decodeError: true };
  }
  return { base64Length: data.length };
}

function summarizeDebugImageUrl(url: string): unknown {
  const trimmed = url.trim();
  const match = trimmed.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is);
  if (match) {
    return {
      mimeType: normalizeImageMimeType(match[1]!),
      ...debugBase64ImageSummary(match[2]!),
    };
  }
  return {
    url: trimmed.startsWith("data:image/")
      ? `<redacted data image ${trimmed.length} chars>`
      : truncateDebugString(trimmed),
  };
}

function summarizeDebugImageObject(value: Record<string, unknown>): unknown | undefined {
  const imageUrl = value.image_url;
  if (imageUrl && typeof imageUrl === "object") {
    const url = (imageUrl as Record<string, unknown>).url;
    if (typeof url === "string")
      return { type: value.type ?? "image_url", image_url: summarizeDebugImageUrl(url) };
  }

  const mimeType =
    typeof value.mimeType === "string" ? normalizeImageMimeType(value.mimeType) : undefined;
  if (!mimeType?.startsWith("image/")) return undefined;
  const data = value.data;
  if (typeof data === "string") {
    return { type: value.type, mimeType, ...debugBase64ImageSummary(data) };
  }
  if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return { type: value.type, mimeType, ...debugByteSummary(bytes) };
  }
  return undefined;
}

const SENSITIVE_DEBUG_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "authorization",
  "access_token",
  "refresh_token",
  "code_verifier",
  "cookie",
  "workoscursorsessiontoken",
  "apikey",
  "api_key",
]);

function isSensitiveDebugKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return (
    SENSITIVE_DEBUG_KEYS.has(key.toLowerCase()) ||
    SENSITIVE_DEBUG_KEYS.has(normalized) ||
    key === "access" ||
    key === "refresh"
  );
}

export function sanitizeForDebug(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactSecrets(truncateDebugString(value));
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return {
      __type: value instanceof Uint8Array ? "Uint8Array" : "Buffer",
      ...debugByteSummary(bytes),
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForDebug(item));
  if (value instanceof Map) {
    return {
      __type: "Map",
      size: value.size,
      entries: Array.from(value.entries())
        .slice(0, 20)
        .map(([k, v]) => [sanitizeForDebug(k), sanitizeForDebug(v)]),
    };
  }
  if (typeof value === "object") {
    const imageSummary = summarizeDebugImageObject(value as Record<string, unknown>);
    if (imageSummary) return imageSummary;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
      if (isSensitiveDebugKey(key)) return [key, "<redacted>"] as const;
      if (key === "data" && typeof inner === "string")
        return [key, `<redacted base64 ${inner.length} chars>`] as const;
      if (key === "url" && typeof inner === "string" && inner.startsWith("data:image/")) {
        return [key, `<redacted data image ${inner.length} chars>`] as const;
      }
      return [key, sanitizeForDebug(inner)] as const;
    });
    return Object.fromEntries(entries);
  }
  return String(value);
}

export function getDebugLogFilePath(): string {
  const configured = process.env.PI_CURSOR_PROVIDER_DEBUG_FILE?.trim();
  if (configured) return configured;
  if (debugLogFilePath) return debugLogFilePath;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  debugLogFilePath = pathJoin(
    getCacheDir() ?? process.cwd(),
    `pi-cursor-provider-debug-${stamp}-${process.pid}.log`,
  );
  return debugLogFilePath;
}

export function debugLog(event: string, data?: Record<string, unknown>): void {
  if (!isStreamDebugEnabled()) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...(data ? (sanitizeForDebug(data) as Record<string, unknown>) : {}),
    });
    const file = getDebugLogFilePath();
    appendFile(file, `${line}\n`, { encoding: "utf8", mode: 0o600 }, (error) => {
      if (error) console.error("[pi-cursor-provider] failed to write debug log", error);
    });
  } catch (error) {
    console.error("[pi-cursor-provider] failed to write debug log", error);
  }
}

/** Always-on compact lifecycle log for diagnosing multi-minute stalls. */
let lifecycleLogPath: string | undefined;
const MAX_LIFECYCLE_LOG_BYTES = 10 * 1024 * 1024;
let lifecycleBytesWritten = 0;

export function getLifecycleLogPath(): string {
  const configured = process.env.PI_CURSOR_LIFECYCLE_LOG?.trim();
  if (configured) return configured;
  if (lifecycleLogPath) return lifecycleLogPath;
  lifecycleLogPath = pathJoin(
    getCacheDir() ?? process.cwd(),
    `pi-cursor-lifecycle-${process.pid}.jsonl`,
  );
  return lifecycleLogPath;
}

export function lifecycleLog(event: string, data?: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...(data ? (sanitizeForDebug(data) as Record<string, unknown>) : {}),
    });
    const encodedBytes = Buffer.byteLength(line) + 1;
    if (lifecycleBytesWritten + encodedBytes > MAX_LIFECYCLE_LOG_BYTES) return;
    lifecycleBytesWritten += encodedBytes;
    appendFile(getLifecycleLogPath(), `${line}\n`, { encoding: "utf8", mode: 0o600 }, () => {});
  } catch {
    // Never throw from diagnostics.
  }
  // Also mirror into verbose debug log when enabled.
  debugLog(`lifecycle.${event}`, data);
}

export type MetricEmitter = (event: string, data: Record<string, unknown>) => void;

const defaultMetricEmitter: MetricEmitter = (event, data) => {
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      event,
      ...(sanitizeForDebug(data) as Record<string, unknown>),
    }),
  );
};

let metricEmitter: MetricEmitter = defaultMetricEmitter;

export function emitMetric(event: string, data: Record<string, unknown>): void {
  try {
    metricEmitter(event, data);
  } catch (error) {
    console.error("[pi-cursor-provider] failed to emit metric", error);
  }
}

export function nextDebugRequestId(): string {
  debugRequestCounter += 1;
  return `req-${debugRequestCounter}`;
}

export function decodeRequestForTests(requestBody: Uint8Array): CursorRequestDebugSummary {
  return requestDebugByBody.get(requestBody) ?? { systemPrompt: "", selectedImages: [] };
}

export function redactForDebug(value: string): string {
  return value
    .replace(/([A-Z0-9_]*TOKEN[A-Z0-9_]*=)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[redacted]");
}

/** Test seam: replace the metric sink (used by __testInternals). */
export function setMetricEmitter(factory?: MetricEmitter): void {
  metricEmitter = factory ?? defaultMetricEmitter;
}
