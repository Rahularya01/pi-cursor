/**
 * Cursor Provider Extension for pi
 *
 * Provides access to Cursor models (Claude, GPT, Gemini, etc.) via:
 * 1. Browser-based PKCE OAuth login to Cursor
 * 2. Native Pi streamSimple provider translating Pi context → Cursor gRPC protocol
 *
 * Usage:
 *   /login cursor    — authenticate via browser
 *   /model           — select any Cursor model
 *
 * Based on https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan.
 */

import rawFallbackModels from "./models/catalog.json" with { type: "json" };
import {
  readStoredCredential,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth/oauth.js";
import { resolveSystemCursorAccessToken, type CredentialSource } from "./auth/cli-credentials.js";
import { resolveSystemCredentialPolicy, systemCredentialsAllowed } from "./auth/consent.js";
import {
  getLastDiagnostics,
  setLastAvailableModels,
  setLastClientVersion,
  setLastTokenSource,
  setSystemCredentialsPolicy,
} from "./diagnostics/index.js";
import { redactSecrets } from "./utils/security.js";
import { formatCursorUsage, getCursorUsageSummary } from "./usage.js";
import { getCursorClientVersion } from "./stream/config.js";
import {
  cleanupSessionState,
  createCursorNativeStream,
  getCursorAgentUrl,
  getCursorModels,
  getCursorParameterizedModels,
  type CursorModel,
  type CursorModelParameter,
  type CursorParameterizedModel,
  type CursorParameterizedVariant,
} from "./stream/native-core.js";

// ── Cost estimation ──

interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

let extensionDebugLogFilePath: string | undefined;

function isExtensionDebugEnabled(): boolean {
  const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
  return !!raw && raw !== "0" && raw !== "false" && raw !== "off";
}

function getExtensionDebugLogFilePath(): string {
  if (extensionDebugLogFilePath) return extensionDebugLogFilePath;
  const configured = process.env.PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE?.trim();
  if (configured) {
    extensionDebugLogFilePath = configured;
    return extensionDebugLogFilePath;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  extensionDebugLogFilePath = pathJoin(
    tmpdir(),
    `pi-cursor-provider-extension-debug-${stamp}-${process.pid}.log`,
  );
  return extensionDebugLogFilePath;
}

function truncateDebugValue(value: string, max = 240): string {
  return value.length > max
    ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>`
    : value;
}

function summarizeBase64ImageData(data: string): {
  base64Length: number;
  byteLength?: number;
  sha256?: string;
} {
  const summary: { base64Length: number; byteLength?: number; sha256?: string } = {
    base64Length: data.length,
  };
  try {
    const bytes = Buffer.from(data.replace(/\s/g, ""), "base64");
    if (bytes.length > 0) {
      summary.byteLength = bytes.length;
      summary.sha256 = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    }
  } catch {
    // Invalid base64 — keep length-only summary.
  }
  return summary;
}

function summarizeImageBlock(type: unknown, mimeType: unknown, data: unknown): unknown {
  return {
    type,
    mimeType,
    ...(typeof data === "string"
      ? summarizeBase64ImageData(data)
      : { data: `<redacted base64 ${String(data ?? "").length} chars>` }),
  };
}

function summarizeDataImageUrl(url: string): unknown {
  const match = url.trim().match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is);
  if (!match)
    return {
      url: url.startsWith("data:image/")
        ? `<redacted data image ${url.length} chars>`
        : truncateDebugValue(url),
    };
  return {
    mimeType: match[1]?.toLowerCase(),
    ...summarizeBase64ImageData(match[2]!),
  };
}

function summarizeContent(content: unknown): unknown {
  if (typeof content === "string") return truncateDebugValue(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const typed = block as Record<string, unknown>;
    switch (typed.type) {
      case "text":
        return { type: "text", text: truncateDebugValue(String(typed.text ?? "")) };
      case "thinking":
        return { type: "thinking", thinking: truncateDebugValue(String(typed.thinking ?? "")) };
      case "toolCall":
        return {
          type: "toolCall",
          id: typed.id,
          name: typed.name,
          arguments: typed.arguments,
        };
      case "image":
        return summarizeImageBlock("image", typed.mimeType, typed.data);
      case "image_url": {
        const url = (typed.image_url as Record<string, unknown> | undefined)?.url;
        const text = typeof url === "string" ? url : "";
        return { type: "image_url", image_url: summarizeDataImageUrl(text) };
      }
      default:
        return typed;
    }
  });
}

function summarizeMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const typed = message as Record<string, unknown>;
  return {
    role: typed.role,
    stopReason: typed.stopReason,
    toolCallId: typed.toolCallId,
    toolName: typed.toolName,
    isError: typed.isError,
    errorMessage: typed.errorMessage,
    content: summarizeContent(typed.content),
  };
}

function summarizeBranchTail(
  ctx: {
    sessionManager?: {
      getBranch?: () => unknown[];
      getLeafId?: () => string | null;
      getSessionId?: () => string;
    };
  },
  limit = 6,
): unknown {
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    return {
      sessionId: ctx.sessionManager?.getSessionId?.(),
      leafId: ctx.sessionManager?.getLeafId?.(),
      size: branch.length,
      tail: branch.slice(-limit).map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const typed = entry as Record<string, unknown>;
        return {
          type: typed.type,
          id: typed.id,
          parentId: typed.parentId,
          customType: typed.customType,
          message: summarizeMessage(typed.message),
        };
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CursorToolResultImagePayload {
  toolCallId: string;
  images: Array<{ data: string; mimeType: string }>;
}

function payloadToolCallIds(payload: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const typed = message as Record<string, unknown>;
    if (typed.role === "tool" && typeof typed.tool_call_id === "string" && typed.tool_call_id)
      ids.add(typed.tool_call_id);
  }
  return ids;
}

export function extractToolResultImagePayloads(
  ctx: { sessionManager?: { getBranch?: () => unknown[] } },
  payload: Record<string, unknown>,
): CursorToolResultImagePayload[] {
  const idsInPayload = payloadToolCallIds(payload);
  if (idsInPayload.size === 0) return [];
  const branch = ctx.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return [];

  const byToolCallId = new Map<string, CursorToolResultImagePayload>();
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const message = (entry as Record<string, unknown>).message;
    if (!message || typeof message !== "object") continue;
    const typed = message as Record<string, unknown>;
    const toolCallId = typeof typed.toolCallId === "string" ? typed.toolCallId : "";
    if (typed.role !== "toolResult" || !toolCallId || !idsInPayload.has(toolCallId)) continue;
    const content = Array.isArray(typed.content) ? typed.content : [];
    const images = content.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const image = block as Record<string, unknown>;
      if (
        image.type !== "image" ||
        typeof image.data !== "string" ||
        typeof image.mimeType !== "string"
      )
        return [];
      return [{ data: image.data, mimeType: image.mimeType }];
    });
    if (images.length === 0) continue;
    const existing = byToolCallId.get(toolCallId);
    if (existing) existing.images.push(...images);
    else byToolCallId.set(toolCallId, { toolCallId, images });
  }
  return [...byToolCallId.values()];
}

function debugExtensionLog(event: string, data?: Record<string, unknown>): void {
  if (!isExtensionDebugEnabled()) return;
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    scope: "extension",
    event,
    ...data,
  });
  appendFileSync(getExtensionDebugLogFilePath(), `${payload}\n`, "utf8");
}

const MODEL_COST_TABLE: Record<string, ModelCost> = {
  "claude-4-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-4.5-haiku": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-4.5-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-4.6-opus": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-4.6-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "composer-1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "composer-1.5": { input: 3.5, output: 17.5, cacheRead: 0.35, cacheWrite: 0 },
  "composer-2": { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.5": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  "grok-4.20": { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
  "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
};

const MODEL_COST_PATTERNS: Array<{ match: (id: string) => boolean; cost: ModelCost }> = [
  {
    match: (id) => /claude.*opus.*fast/i.test(id),
    cost: { input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 },
  },
  { match: (id) => /claude.*opus/i.test(id), cost: MODEL_COST_TABLE["claude-4.6-opus"]! },
  { match: (id) => /claude.*haiku/i.test(id), cost: MODEL_COST_TABLE["claude-4.5-haiku"]! },
  { match: (id) => /claude.*sonnet/i.test(id), cost: MODEL_COST_TABLE["claude-4.6-sonnet"]! },
  { match: (id) => /composer/i.test(id), cost: MODEL_COST_TABLE["composer-1"]! },
  { match: (id) => /gpt-5\.5/i.test(id), cost: MODEL_COST_TABLE["gpt-5.5"]! },
  { match: (id) => /gpt-5\.4.*mini/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4-mini"]! },
  { match: (id) => /gpt-5\.4/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4"]! },
  { match: (id) => /gpt-5\.3/i.test(id), cost: MODEL_COST_TABLE["gpt-5.3-codex"]! },
  { match: (id) => /gpt-5\.2/i.test(id), cost: MODEL_COST_TABLE["gpt-5.2"]! },
  { match: (id) => /gpt-5.*mini/i.test(id), cost: MODEL_COST_TABLE["gpt-5-mini"]! },
  { match: (id) => /gpt-5/i.test(id), cost: MODEL_COST_TABLE["gpt-5"]! },
  { match: (id) => /gemini.*3\.1/i.test(id), cost: MODEL_COST_TABLE["gemini-3.1-pro"]! },
  { match: (id) => /gemini.*flash/i.test(id), cost: MODEL_COST_TABLE["gemini-2.5-flash"]! },
  { match: (id) => /gemini/i.test(id), cost: MODEL_COST_TABLE["gemini-3-pro"]! },
  { match: (id) => /grok/i.test(id), cost: MODEL_COST_TABLE["grok-4.20"]! },
  { match: (id) => /kimi/i.test(id), cost: MODEL_COST_TABLE["kimi-k2.5"]! },
];

const DEFAULT_COST: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 };

function estimateModelCost(modelId: string): ModelCost {
  const normalized = modelId.toLowerCase();
  const exact = MODEL_COST_TABLE[normalized];
  if (exact) return exact;
  const stripped = normalized.replace(
    /-(high|medium|low|preview|thinking|spark-preview|fast)$/g,
    "",
  );
  const strippedMatch = MODEL_COST_TABLE[stripped];
  if (strippedMatch) return strippedMatch;
  return MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST;
}

// ── Effort-level dedup ──

const CURSOR_EFFORT_SUFFIXES: Array<{ suffix: string; effort: string }> = [
  { suffix: "extra-high", effort: "xhigh" },
  { suffix: "minimal", effort: "minimal" },
  { suffix: "xhigh", effort: "xhigh" },
  { suffix: "medium", effort: "medium" },
  { suffix: "high", effort: "high" },
  { suffix: "low", effort: "low" },
  { suffix: "max", effort: "max" },
  { suffix: "none", effort: "none" },
];

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type CursorEffortMap = Record<PiThinkingLevel, string | null>;

interface ParsedModelId {
  base: string; // model ID with effort stripped
  effort: string; // effort level, or "" if no effort suffix
  fast: boolean; // has -fast suffix
  thinking: boolean; // has -thinking suffix
}

function stripEffortSuffix(id: string): { remaining: string; effort: string } {
  for (const { suffix, effort } of CURSOR_EFFORT_SUFFIXES) {
    const marker = `-${suffix}`;
    if (id.endsWith(marker)) {
      return { remaining: id.slice(0, -marker.length), effort };
    }
  }
  return { remaining: id, effort: "" };
}

export function parseModelId(id: string): ParsedModelId {
  let remaining = id;
  let fast = false;
  let thinking = false;

  if (remaining.endsWith("-fast")) {
    fast = true;
    remaining = remaining.slice(0, -5);
  }

  // Cursor has used both orders for thinking effort variants:
  //   claude-4.6-opus-max-thinking       (effort before -thinking)
  //   claude-opus-4-7-thinking-max       (effort after -thinking)
  let effort: string;
  if (remaining.endsWith("-thinking")) {
    thinking = true;
    remaining = remaining.slice(0, -9);
    const parsed = stripEffortSuffix(remaining);
    remaining = parsed.remaining;
    effort = parsed.effort;
  } else {
    const parsed = stripEffortSuffix(remaining);
    remaining = parsed.remaining;
    effort = parsed.effort;
    if (remaining.endsWith("-thinking")) {
      thinking = true;
      remaining = remaining.slice(0, -9);
    }
  }

  return { base: remaining, effort, fast, thinking };
}

export interface CursorModelRouting {
  modelId: string;
  parameters?: CursorModelParameter[];
  requiresMaxMode?: boolean;
  requestedMaxMode?: boolean;
}

export interface ProcessedModel extends CursorModel {
  supportsEffort: boolean;
  effortMap?: CursorEffortMap;
  rawModelByEffort?: Record<string, string>;
  rawRoutingByEffort?: Record<string, CursorModelRouting>;
}

export function buildNoReasoningEffortLookup(models: ProcessedModel[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const model of models) {
    if (
      model.supportsEffort &&
      model.effortMap &&
      Object.values(model.effortMap).includes("none")
    ) {
      lookup.set(model.id, "none");
    }
  }
  return lookup;
}

function routingForModel(model: CursorModel): CursorModelRouting | undefined {
  if (
    !model.requestedModelId &&
    !model.parameters?.length &&
    !model.requiresMaxMode &&
    typeof model.requestedMaxMode !== "boolean"
  ) {
    return undefined;
  }
  return {
    modelId: model.requestedModelId ?? model.id,
    ...(model.parameters?.length ? { parameters: model.parameters } : {}),
    ...(model.requiresMaxMode ? { requiresMaxMode: true } : {}),
    ...(typeof model.requestedMaxMode === "boolean"
      ? { requestedMaxMode: model.requestedMaxMode }
      : {}),
  };
}

function defaultRoutingEffort(model: ProcessedModel): string | undefined {
  const routes = model.rawRoutingByEffort;
  if (!routes) return undefined;
  const mappedMedium = model.effortMap?.medium;
  for (const effort of [mappedMedium, "medium", "", "low", "high", "none", "xhigh", "max"]) {
    if (typeof effort === "string" && routes[effort]) return effort;
  }
  return Object.keys(routes)[0];
}

export function buildRawModelLookup(
  models: ProcessedModel[],
): Map<string, Record<string, CursorModelRouting>> {
  const lookup = new Map<string, Record<string, CursorModelRouting>>();
  for (const model of models) {
    if (model.supportsEffort && model.rawRoutingByEffort) {
      const routes = { ...model.rawRoutingByEffort };
      if (model.effortMap) {
        for (const [piEffort, cursorEffort] of Object.entries(model.effortMap)) {
          if (typeof cursorEffort === "string" && !routes[piEffort] && routes[cursorEffort]) {
            routes[piEffort] = routes[cursorEffort];
          }
        }
      }
      const defaultEffort = defaultRoutingEffort(model);
      if (defaultEffort !== undefined && !routes[""])
        routes[""] = model.rawRoutingByEffort[defaultEffort]!;
      lookup.set(model.id, routes);
      continue;
    }

    const routing = routingForModel(model);
    if (routing) lookup.set(model.id, { "": routing });
  }
  return lookup;
}

export function applyRawCursorModelId(
  payload: Record<string, unknown>,
  rawRoutingByEffortByModelId: Map<string, Record<string, CursorModelRouting>>,
): void {
  if (typeof payload.model !== "string") return;
  const rawRoutingByEffort = rawRoutingByEffortByModelId.get(payload.model);
  const effort = typeof payload.reasoning_effort === "string" ? payload.reasoning_effort : "";
  const routing = rawRoutingByEffort?.[effort];
  if (!routing) return;
  payload.cursor_model_id = routing.modelId;
  if (routing.parameters?.length) payload.cursor_model_parameters = routing.parameters;
  if (routing.requiresMaxMode) payload.cursor_requires_max_mode = true;
  if (typeof routing.requestedMaxMode === "boolean")
    payload.cursor_model_max_mode = routing.requestedMaxMode;
}

export function applyNoReasoningEffort(
  payload: Record<string, unknown>,
  thinkingLevel: string,
  noReasoningEffortByModelId: Map<string, string>,
): void {
  if (
    thinkingLevel !== "off" ||
    payload.reasoning_effort !== undefined ||
    typeof payload.model !== "string"
  )
    return;
  const noReasoningEffort = noReasoningEffortByModelId.get(payload.model);
  if (noReasoningEffort) payload.reasoning_effort = noReasoningEffort;
}

export function supportsReasoningModelId(id: string): boolean {
  const { base, effort, thinking } = parseModelId(id);
  if (effort || thinking) return true;
  if (base === "default" || base === "auto") return true;
  return /^(claude|composer|gemini|gpt|grok|kimi)(-|$)/i.test(base);
}

/**
 * Map only controls Cursor explicitly advertised. Null hides unsupported Pi
 * levels instead of silently routing them to a different Cursor effort.
 */
export function buildEffortMap(efforts: Set<string>): CursorEffortMap {
  const supported = (effort: string): string | null => (efforts.has(effort) ? effort : null);
  return {
    off: supported("none"),
    minimal: supported("minimal"),
    low: supported("low"),
    // A bare Cursor model ID is the provider's default effort, equivalent to Pi medium.
    medium: efforts.has("medium") ? "medium" : supported(""),
    high: supported("high"),
    xhigh: supported("xhigh"),
    max: supported("max"),
  };
}

/** Dedup raw models: collapse effort variants into one entry with supportsReasoningEffort. */
export function processModels(raw: CursorModel[]): ProcessedModel[] {
  // Group by (base, fast, thinking)
  const groups = new Map<
    string,
    {
      base: string;
      fast: boolean;
      thinking: boolean;
      efforts: Map<string, CursorModel>;
    }
  >();

  for (const model of raw) {
    const p = parseModelId(model.id);
    const key = `${p.base}|${p.fast}|${p.thinking}`;
    let g = groups.get(key);
    if (!g) {
      g = { base: p.base, fast: p.fast, thinking: p.thinking, efforts: new Map() };
      groups.set(key, g);
    }
    g.efforts.set(p.effort, model);
  }

  const result: ProcessedModel[] = [];

  for (const g of groups.values()) {
    const effortNames = new Set(g.efforts.keys());

    // Dedup when there are multiple effort variants, OR a single variant
    // whose effort is non-empty (e.g. claude-4.5-opus-high — strip the
    // mandatory effort suffix so the model appears as claude-4.5-opus
    // with effort mapping).
    const hasOnlyEffortVariants = g.efforts.size === 1 && !g.efforts.has("");
    const shouldDedup = effortNames.size >= 2 || hasOnlyEffortVariants;
    if (shouldDedup) {
      // Pick representative: prefer "medium" or default ("") for name/metadata
      const rep = g.efforts.get("medium") ?? g.efforts.get("") ?? [...g.efforts.values()][0]!;

      // Build deduped model ID: base + thinking/fast suffix (no effort)
      let id = g.base;
      if (g.thinking) id += "-thinking";
      if (g.fast) id += "-fast";

      const effortMap = buildEffortMap(effortNames);
      const rawModelByEffort = Object.fromEntries(
        [...g.efforts.entries()].map(([effort, model]) => [effort, model.id]),
      );
      const rawRoutingByEffort = Object.fromEntries(
        [...g.efforts.entries()].map(([effort, model]) => [
          effort,
          {
            modelId: model.requestedModelId ?? model.id,
            ...(model.parameters?.length ? { parameters: model.parameters } : {}),
            ...(model.requiresMaxMode ? { requiresMaxMode: true } : {}),
            ...(typeof model.requestedMaxMode === "boolean"
              ? { requestedMaxMode: model.requestedMaxMode }
              : {}),
          },
        ]),
      );

      result.push({
        ...rep,
        id,
        supportsEffort: true,
        effortMap,
        rawModelByEffort,
        rawRoutingByEffort,
      });
    } else {
      // Keep single entries as-is (base model without effort variants)
      for (const model of g.efforts.values()) {
        result.push({ ...model, supportsEffort: false });
      }
    }
  }

  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function modelConfig(m: ProcessedModel) {
  const input = (m.supportsImages === false ? ["text"] : ["text", "image"]) as ("text" | "image")[];
  return {
    id: m.id,
    name: m.name,
    // Pi's thinking control must only appear when Cursor exposed selectable
    // effort variants. A model name alone is not evidence of a controllable level.
    reasoning: m.supportsEffort,
    ...(m.supportsEffort &&
      m.effortMap && {
        thinkingLevelMap: m.effortMap,
      }),
    input,
    cost: estimateModelCost(m.id),
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
}

const GPT55_VARIANTS = [
  {
    idPart: "",
    label: "272K",
    context: "272k",
    contextWindow: 272_000,
    requestedMaxMode: false,
    fastOptions: [false, true],
  },
  {
    idPart: "-max",
    label: "272K Max",
    context: "272k",
    contextWindow: 272_000,
    requestedMaxMode: true,
    fastOptions: [false, true],
  },
  {
    idPart: "-1m",
    label: "1M",
    context: "1m",
    contextWindow: 1_000_000,
    requestedMaxMode: true,
    fastOptions: [false],
  },
] as const;

const GPT55_REASONING_LEVELS = [
  { suffix: "none", label: "None", value: "none" },
  { suffix: "low", label: "Low", value: "low" },
  { suffix: "medium", label: "", value: "medium" },
  { suffix: "high", label: "High", value: "high" },
  { suffix: "extra-high", label: "Extra High", value: "extra-high" },
] as const;

function gpt55ParameterizedModels(): CursorModel[] {
  const models: CursorModel[] = [];
  for (const variant of GPT55_VARIANTS) {
    // Cursor treats maxMode as an orthogonal request flag. The model picker
    // cannot toggle Cursor-specific flags, so expose useful maxMode states as
    // explicit rows. Cursor's metadata does not include context=1m + fast=true,
    // so the 1M variant intentionally has fast=false only.
    for (const fast of variant.fastOptions) {
      for (const reasoning of GPT55_REASONING_LEVELS) {
        const id = `gpt-5.5${variant.idPart}-${reasoning.suffix}${fast ? "-fast" : ""}`;
        const nameParts = ["GPT-5.5", variant.label, reasoning.label, fast ? "Fast" : ""].filter(
          Boolean,
        );
        models.push({
          id,
          name: nameParts.join(" "),
          reasoning: true,
          contextWindow: variant.contextWindow,
          maxTokens: 64_000,
          requestedModelId: "gpt-5.5",
          requiresMaxMode: variant.context === "1m",
          requestedMaxMode: variant.requestedMaxMode,
          parameters: [
            { id: "context", value: variant.context },
            { id: "reasoning", value: reasoning.value },
            { id: "fast", value: String(fast) },
          ],
        });
      }
    }
  }
  return models;
}

function parameterValue(parameters: CursorModelParameter[], id: string): string | undefined {
  return parameters.find((parameter) => parameter.id === id)?.value;
}

function contextWindowFromParameter(context: string | undefined, fallback = 200_000): number {
  if (context === "272k") return 272_000;
  if (context === "1m") return 1_000_000;
  const k = context?.match(/^(\d+)k$/i)?.[1];
  if (k) return Number(k) * 1_000;
  const m = context?.match(/^(\d+)m$/i)?.[1];
  if (m) return Number(m) * 1_000_000;
  return fallback;
}

function cursorEffortSuffix(value: string): string {
  return value;
}

function cursorEffortLabel(value: string): string {
  return (
    GPT55_REASONING_LEVELS.find((level) => level.value === value)?.label ||
    ({ xhigh: "Extra High", max: "Max", none: "None" } as Record<string, string>)[value] ||
    value.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

function metadataEffortParameterId(
  variant: CursorParameterizedVariant,
): "reasoning" | "effort" | undefined {
  if (variant.parameters.some((parameter) => parameter.id === "reasoning")) return "reasoning";
  if (variant.parameters.some((parameter) => parameter.id === "effort")) return "effort";
  return undefined;
}

function isDefaultContext(context: string | undefined): boolean {
  if (!context) return true;
  return context === "200k" || context === "272k" || context === "300k";
}

function contextIdPart(context: string | undefined): string {
  return context && !isDefaultContext(context) ? `-${context.toLowerCase()}` : "";
}

function contextLabel(context: string | undefined): string | undefined {
  if (!context || isDefaultContext(context)) return undefined;
  return context.toUpperCase();
}

function maxModeIdPart(
  modelName: string,
  context: string | undefined,
  requestedMaxMode: boolean,
  hasEffortParameter: boolean,
): string {
  // 1M context already names the Max/extended-context selection. For default
  // context windows, expose maxMode as an explicit row suffix. If the Cursor
  // model ID already contains "max" (for example gpt-5.1-codex-max), or if
  // this row has no effort parameter, use a clearer suffix so the model parser
  // does not confuse Max Mode with a Cursor effort value.
  if (!requestedMaxMode || context === "1m") return "";
  return !hasEffortParameter || /(^|-)max($|-)/i.test(modelName) ? "-max-mode" : "-max";
}

function maxModeLabel(
  modelName: string,
  context: string | undefined,
  requestedMaxMode: boolean,
  hasEffortParameter: boolean,
): string | undefined {
  const idPart = maxModeIdPart(modelName, context, requestedMaxMode, hasEffortParameter);
  if (!idPart) return undefined;
  return idPart === "-max-mode" ? "Max Mode" : "Max";
}

function parameterizedBaseId(
  modelName: string,
  variant: CursorParameterizedVariant,
  requestedMaxMode: boolean,
  hasEffortParameter: boolean,
): string {
  const context = parameterValue(variant.parameters, "context");
  return `${modelName}${contextIdPart(context)}${maxModeIdPart(modelName, context, requestedMaxMode, hasEffortParameter)}`;
}

function parameterizedBaseLabel(
  model: CursorParameterizedModel,
  variant: CursorParameterizedVariant,
  requestedMaxMode: boolean,
  hasEffortParameter: boolean,
): string[] {
  const context = parameterValue(variant.parameters, "context");
  return [
    model.clientDisplayName || model.name,
    contextLabel(context),
    maxModeLabel(model.name, context, requestedMaxMode, hasEffortParameter),
  ].filter(Boolean) as string[];
}

function hasVariantParameterSet(
  model: CursorParameterizedModel,
  parameters: CursorModelParameter[],
): boolean {
  const normalized = normalizeParameterValues(parameters);
  return model.variants.some(
    (variant) => normalizeParameterValues(variant.parameters) === normalized,
  );
}

function normalizeParameterValues(parameters: CursorModelParameter[]): string {
  return parameters
    .map((parameter) => `${parameter.id}=${parameter.value}`)
    .sort()
    .join(";");
}

function buildParameterizedRowsFromGroup(options: {
  model: CursorParameterizedModel;
  variants: CursorParameterizedVariant[];
  requestedMaxMode: boolean;
  effortParameterId?: "reasoning" | "effort";
}): CursorModel[] {
  const first = options.variants[0];
  if (!first) return [];
  if (options.requestedMaxMode && !first.isMaxMode && !options.model.supportsMaxMode) return [];

  const context = parameterValue(first.parameters, "context");
  const fast = parameterValue(first.parameters, "fast") === "true";
  const thinking = parameterValue(first.parameters, "thinking") === "true";
  const hasEffortParameter = Boolean(options.effortParameterId);
  const baseId = parameterizedBaseId(
    options.model.name,
    first,
    options.requestedMaxMode,
    hasEffortParameter,
  );
  const baseLabelParts = parameterizedBaseLabel(
    options.model,
    first,
    options.requestedMaxMode,
    hasEffortParameter,
  );
  const contextWindow = contextWindowFromParameter(
    context,
    options.requestedMaxMode
      ? (options.model.contextTokenLimitForMaxMode ?? options.model.contextTokenLimit ?? 200_000)
      : (options.model.contextTokenLimit ?? 200_000),
  );

  return options.variants.flatMap((variant) => {
    const parameters = variant.parameters.map((parameter) => ({
      id: parameter.id,
      value: parameter.value,
    }));
    if (!hasVariantParameterSet(options.model, parameters)) return [];

    const effort = options.effortParameterId
      ? parameterValue(variant.parameters, options.effortParameterId)
      : undefined;
    const id = options.effortParameterId
      ? `${baseId}-${cursorEffortSuffix(effort!)}${thinking ? "-thinking" : ""}${fast ? "-fast" : ""}`
      : `${baseId}${thinking ? "-thinking" : ""}${fast ? "-fast" : ""}`;
    const name = [
      ...baseLabelParts,
      effort ? cursorEffortLabel(effort) : undefined,
      thinking ? "Thinking" : undefined,
      fast ? "Fast" : undefined,
    ]
      .filter(Boolean)
      .join(" ");

    return [
      {
        id,
        name,
        reasoning: Boolean(options.effortParameterId) || thinking,
        contextWindow,
        maxTokens: 64_000,
        requestedModelId: options.model.name,
        requiresMaxMode: variant.isMaxMode,
        requestedMaxMode: options.requestedMaxMode,
        supportsImages: options.model.supportsImages,
        parameters,
      } satisfies CursorModel,
    ];
  });
}

function parameterGroupKey(
  variant: CursorParameterizedVariant,
  effortParameterId?: string,
): string {
  const params = variant.parameters
    .filter((parameter) => parameter.id !== effortParameterId)
    .map((parameter) => `${parameter.id}=${parameter.value}`)
    .sort()
    .join(";");
  return `${variant.isMaxMode ? "max" : "nonmax"}|${params}`;
}

function shouldGenerateSyntheticMaxRows(
  model: CursorParameterizedModel,
  variant: CursorParameterizedVariant,
): boolean {
  // Cursor's metadata has both per-variant isMaxMode and model-level
  // supportsMaxMode. Some supported Max Mode combinations are represented only
  // by supportsMaxMode=true over a non-Max parameter set, so expose explicit
  // max-mode rows for every such advertised parameter set.
  return model.supportsMaxMode === true && !variant.isMaxMode;
}

export function modelsFromParameterizedMetadata(
  parameterizedModels: CursorParameterizedModel[],
): CursorModel[] {
  const rows: CursorModel[] = [];
  for (const model of parameterizedModels) {
    const groups = new Map<
      string,
      { effortParameterId?: "reasoning" | "effort"; variants: CursorParameterizedVariant[] }
    >();
    for (const variant of model.variants) {
      if (variant.parameters.length === 0) continue;
      const effortParameterId = metadataEffortParameterId(variant);
      const key = parameterGroupKey(variant, effortParameterId);
      const group = groups.get(key) ?? { effortParameterId, variants: [] };
      group.variants.push(variant);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const first = group.variants[0];
      if (!first) continue;
      rows.push(
        ...buildParameterizedRowsFromGroup({
          model,
          variants: group.variants,
          requestedMaxMode: first.isMaxMode,
          effortParameterId: group.effortParameterId,
        }),
      );
      if (shouldGenerateSyntheticMaxRows(model, first)) {
        rows.push(
          ...buildParameterizedRowsFromGroup({
            model,
            variants: group.variants,
            requestedMaxMode: true,
            effortParameterId: group.effortParameterId,
          }),
        );
      }
    }
  }
  return rows;
}

function normalizeDisplayModel(model: CursorModel): CursorModel {
  if (model.id !== "default") return model;
  return {
    ...model,
    id: "auto",
    name: model.name && model.name !== "default" ? model.name : "Auto",
    requestedModelId: model.requestedModelId ?? "default",
  };
}

export function augmentCursorModels(
  raw: CursorModel[],
  parameterizedModels: CursorParameterizedModel[] = [],
): CursorModel[] {
  const byId = new Map<string, CursorModel>();
  const imageSupportByModelId = new Map(
    parameterizedModels
      .filter((model) => typeof model.supportsImages === "boolean")
      .map((model) => [model.name, model.supportsImages!]),
  );
  for (const model of raw.map(normalizeDisplayModel)) {
    const lookupId = model.requestedModelId ?? model.id;
    const metadataSupportsImages = imageSupportByModelId.get(lookupId);
    byId.set(model.id, {
      ...model,
      ...(model.supportsImages === undefined && metadataSupportsImages !== undefined
        ? { supportsImages: metadataSupportsImages }
        : {}),
    });
  }

  const metadataRows =
    modelsFromParameterizedMetadata(parameterizedModels).map(normalizeDisplayModel);
  for (const model of metadataRows) byId.set(model.id, model);

  // Fallback for static/offline discovery. Cursor exposes GPT-5.5 context as
  // parameters (272K vs 1M), not distinct backend model IDs.
  if (metadataRows.length === 0 && raw.some((model) => /^gpt-5\.5(?:-|$)/.test(model.id))) {
    for (const model of gpt55ParameterizedModels()) byId.set(model.id, model);
  }

  return [...byId.values()];
}

export const FALLBACK_MODELS: CursorModel[] = augmentCursorModels(
  rawFallbackModels as CursorModel[],
).map((model) => ({
  ...model,
  reasoning: supportsReasoningModelId(model.id),
}));

// ── Extension ──

const CURSOR_PROVIDER_ID = "cursor";

async function getStoredCursorOAuthAccessToken(): Promise<
  { accessToken: string; source: CredentialSource } | undefined
> {
  const credential = readStoredCredential(CURSOR_PROVIDER_ID);
  if (!credential || credential.type !== "oauth") return undefined;

  if (Date.now() < credential.expires && credential.access) {
    return { accessToken: credential.access, source: "pi_oauth" };
  }

  // Refresh is handled by Pi's OAuth runtime on demand; avoid writing auth.json here.
  if (credential.refresh) {
    try {
      const refreshed = await refreshCursorToken(credential.refresh);
      return { accessToken: refreshed.access, source: "pi_oauth_refresh" };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function getStartupCursorAccessToken(options?: {
  forceRefresh?: boolean;
}): Promise<{ accessToken: string; source: CredentialSource } | undefined> {
  const systemToken = await resolveSystemCursorAccessToken(options);
  if (systemToken) return systemToken;
  return getStoredCursorOAuthAccessToken();
}

function isTokenNearExpiry(token: string, skewMs = 60_000): boolean {
  try {
    return Date.now() >= getTokenExpiry(token) - skewMs;
  } catch {
    return true;
  }
}

export function registerSessionLifecycleCleanup(pi: ExtensionAPI) {
  const cleanupCurrentSession = (_event: unknown, ctx: ExtensionContext) => {
    debugExtensionLog("session.cleanup_hook", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
    });
    cleanupSessionState(ctx.sessionManager.getSessionId());
  };

  pi.on("session_before_switch", cleanupCurrentSession);
  pi.on("session_before_fork", cleanupCurrentSession);
  pi.on("session_before_tree", cleanupCurrentSession);
  pi.on("session_shutdown", cleanupCurrentSession);
}

function registerExtensionDebugHooks(pi: ExtensionAPI) {
  if (!isExtensionDebugEnabled()) return;

  pi.on("message_start", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.start", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
    });
  });

  pi.on("message_update", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as {
      message?: unknown;
      assistantMessageEvent?: Record<string, unknown>;
    };
    debugExtensionLog("message.update", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      assistantMessageEvent: typedEvent.assistantMessageEvent
        ? {
            type: typedEvent.assistantMessageEvent.type,
            delta: truncateDebugValue(
              String(
                (typedEvent.assistantMessageEvent as Record<string, unknown>).delta ??
                  (typedEvent.assistantMessageEvent as Record<string, unknown>).content ??
                  "",
              ),
            ),
          }
        : undefined,
      message: summarizeMessage(typedEvent.message),
    });
  });

  pi.on("message_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("context", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as { messages?: unknown[] };
    debugExtensionLog("context", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      messageCount: Array.isArray(typedEvent.messages) ? typedEvent.messages.length : undefined,
      messages: Array.isArray(typedEvent.messages)
        ? typedEvent.messages.slice(-8).map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as { turnIndex?: number; message?: unknown; toolResults?: unknown[] };
    debugExtensionLog("turn.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      turnIndex: typedEvent.turnIndex,
      message: summarizeMessage(typedEvent.message),
      toolResults: Array.isArray(typedEvent.toolResults)
        ? typedEvent.toolResults.map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  debugExtensionLog("extension.debug_hooks_registered", {
    logFile: getExtensionDebugLogFilePath(),
  });
}

export default async function (pi: ExtensionAPI) {
  // Current access token, updated by login/refresh/getApiKey
  let currentToken = "";
  let currentTokenSource: CredentialSource | "none" = "none";
  let noReasoningEffortByModelId = new Map<string, string>();
  let rawModelByEffortByModelId = new Map<string, Record<string, CursorModelRouting>>();
  let lastRegisteredModels: ProcessedModel[] = [];

  setSystemCredentialsPolicy(resolveSystemCredentialPolicy());
  setLastClientVersion(getCursorClientVersion());

  const getAccessToken = async (options?: { forceRefresh?: boolean }) => {
    const needsRefresh =
      options?.forceRefresh ||
      !currentToken ||
      (currentTokenSource !== "env" && isTokenNearExpiry(currentToken));

    if (needsRefresh) {
      const resolved = await getStartupCursorAccessToken({
        forceRefresh: options?.forceRefresh || isTokenNearExpiry(currentToken || "x"),
      });
      if (resolved) {
        currentToken = resolved.accessToken;
        currentTokenSource = resolved.source;
        setLastTokenSource(resolved.source);
      } else if (options?.forceRefresh) {
        // Keep previous token only if force refresh failed and we still have one.
        setLastTokenSource(currentTokenSource || "none");
      }
    }

    if (!currentToken) {
      const consentHint = systemCredentialsAllowed()
        ? ""
        : " System credential reuse is disabled (PI_CURSOR_SYSTEM_CREDENTIALS=0).";
      throw new Error(
        `Not logged in to Cursor. Run /login cursor or log in via Cursor CLI.${consentHint}`,
      );
    }
    setLastTokenSource(currentTokenSource);
    return currentToken;
  };

  const skipDedup = !!process.env.PI_CURSOR_RAW_MODELS;

  registerSessionLifecycleCleanup(pi);
  registerExtensionDebugHooks(pi);
  debugExtensionLog("extension.start", {
    mode: "native-streamSimple",
    debugLogFile: isExtensionDebugEnabled() ? getExtensionDebugLogFilePath() : undefined,
  });

  const startupModels = await discoverStartupModels();
  register(pi, startupModels.rawModels, startupModels.parameterizedModels);

  pi.registerCommand("cursor.models", {
    description: "List Cursor runtime models registered by this provider",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const all = /\ball\b/i.test(args || "");
      const rows = all
        ? lastRegisteredModels
        : lastRegisteredModels.filter((m) => !/tab_|chat_/i.test(m.id));
      const lines = [
        `Cursor models (${rows.length}${all ? " all" : ""})`,
        `endpoint=${getCursorAgentUrl()}`,
        "",
      ];
      const maxId = Math.max(8, ...rows.map((m) => m.id.length));
      for (const m of rows) {
        const processed = m as ProcessedModel;
        const levels = Object.entries(processed.effortMap ?? {})
          .filter(([, cursorEffort]) => typeof cursorEffort === "string")
          .map(([level]) => level)
          .join("/");
        const flags = [
          processed.supportsEffort ? "thinking" : "",
          levels ? `levels=${levels}` : "",
          m.supportsImages ? "images" : "",
        ]
          .filter(Boolean)
          .join(",");
        lines.push(
          `${m.id.padEnd(maxId)}  ctx ${String(m.contextWindow ?? "?").padStart(7)}  ${m.name || ""}${flags ? `  [${flags}]` : ""}`,
        );
      }
      if (!rows.length) lines.push("No models registered. Run /login cursor first.");
      const text = lines.join("\n");
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      console.log(text);
    },
  });

  pi.registerCommand("cursor.usage", {
    description: "Show Cursor plan quota and on-demand spend",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      try {
        const text = formatCursorUsage(await getCursorUsageSummary(getAccessToken));
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        console.log(text);
      } catch (error) {
        const text = `Cursor usage unavailable: ${redactSecrets(
          error instanceof Error ? error.message : String(error),
        )}`;
        if (ctx.hasUI) ctx.ui.notify(text, "error");
        console.error(text);
      }
    },
  });

  pi.registerCommand("cursor.doctor", {
    description: "Show sanitized Cursor provider diagnostics",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const d = getLastDiagnostics();
      const lines = [
        `provider=${CURSOR_PROVIDER_ID}`,
        `agentUrl=${getCursorAgentUrl()}`,
        `clientVersion=${d.clientVersion || getCursorClientVersion()}`,
        `tokenSource=${d.tokenSource || currentTokenSource || "none"}`,
        `systemCredentials=${d.systemCredentials || resolveSystemCredentialPolicy()}`,
        `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
        `availableModels=${d.availableModels || lastRegisteredModels.length || "none"}`,
        `matchedModel=${d.matchedModelDebug || "none"}`,
        `lastEndpoint=${d.endpoint || "none"}`,
        `lastStatus=${d.status ?? "none"}`,
        `lastRpc=${d.lastRpc || "none"}`,
        `lastRecoverySkipReason=${d.lastRecoverySkipReason || "none"}`,
        `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
        "transport=native-streamSimple",
        "runtimeCli=not-used",
        "proxyPath=quarantined-internal",
        "commands=/cursor.models /cursor.usage /cursor.doctor",
        "hint=On wire errors set PI_CURSOR_CLIENT_VERSION or re-login; opt out of Keychain/IDE scrape with PI_CURSOR_SYSTEM_CREDENTIALS=0",
      ];
      const text = lines.join("\n");
      if (ctx.hasUI) ctx.ui.notify(`Cursor doctor\n${text}`, "info");
      console.log(text);
    },
  });

  async function discoverStartupModels(): Promise<{
    rawModels: CursorModel[];
    parameterizedModels: CursorParameterizedModel[];
  }> {
    if (process.env.PI_OFFLINE) return { rawModels: FALLBACK_MODELS, parameterizedModels: [] };

    let startupToken: { accessToken: string; source: CredentialSource } | undefined;
    try {
      startupToken = await getStartupCursorAccessToken();
    } catch (err) {
      debugExtensionLog("model_discovery.startup.token_failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (!startupToken) {
      debugExtensionLog("model_discovery.startup.skipped", { reason: "no_cursor_oauth_token" });
      return { rawModels: FALLBACK_MODELS, parameterizedModels: [] };
    }

    try {
      currentToken = startupToken.accessToken;
      currentTokenSource = startupToken.source;
      const [discovered, parameterized] = await Promise.all([
        getCursorModels(startupToken.accessToken),
        getCursorParameterizedModels(startupToken.accessToken),
      ]);
      debugExtensionLog("model_discovery.startup", {
        tokenSource: startupToken.source,
        discoveredCount: discovered.length,
        parameterizedCount: parameterized.length,
      });
      if (discovered.length > 0 || parameterized.length > 0) {
        return {
          rawModels: discovered.length > 0 ? discovered : FALLBACK_MODELS,
          parameterizedModels: parameterized,
        };
      }
    } catch (err) {
      debugExtensionLog("model_discovery.startup.failed", {
        tokenSource: startupToken.source,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return { rawModels: FALLBACK_MODELS, parameterizedModels: [] };
  }

  function register(
    pi: ExtensionAPI,
    rawModels: CursorModel[],
    parameterizedModels: CursorParameterizedModel[] = [],
  ) {
    const augmentedModels = augmentCursorModels(rawModels, parameterizedModels);
    const processed = skipDedup
      ? augmentedModels.map((m) => ({ ...m, supportsEffort: false }) as ProcessedModel)
      : processModels(augmentedModels);
    lastRegisteredModels = processed;
    setLastAvailableModels(
      processed
        .map((m) => m.id)
        .slice(0, 24)
        .join(","),
    );
    noReasoningEffortByModelId = buildNoReasoningEffortLookup(processed);
    rawModelByEffortByModelId = buildRawModelLookup(processed);

    pi.registerProvider("cursor", {
      baseUrl: getCursorAgentUrl(),
      api: "cursor-native",
      streamSimple: createCursorNativeStream({
        getAccessToken,
        getNoReasoningEffortByModelId: () => noReasoningEffortByModelId,
        getRawModelRoutingByModelId: () => rawModelByEffortByModelId,
      }),
      models: processed.map(modelConfig),
      oauth: {
        name: "Cursor",

        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
          callbacks.onAuth({ url: loginUrl });
          const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);
          currentToken = accessToken;
          currentTokenSource = "pi_oauth";

          // Discover real models and re-register
          const [discovered, parameterized] = await Promise.all([
            getCursorModels(accessToken),
            getCursorParameterizedModels(accessToken),
          ]);
          if (discovered.length > 0 || parameterized.length > 0) {
            register(pi, discovered.length > 0 ? discovered : FALLBACK_MODELS, parameterized);
          }

          return {
            refresh: refreshToken,
            access: accessToken,
            expires: getTokenExpiry(accessToken),
          };
        },

        async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
          const refreshed = await refreshCursorToken(credentials.refresh);
          currentToken = refreshed.access;
          currentTokenSource = "pi_oauth_refresh";

          // Discover real models on refresh too
          const [discovered, parameterized] = await Promise.all([
            getCursorModels(refreshed.access),
            getCursorParameterizedModels(refreshed.access),
          ]);
          if (discovered.length > 0 || parameterized.length > 0) {
            register(pi, discovered.length > 0 ? discovered : FALLBACK_MODELS, parameterized);
          }

          return refreshed as OAuthCredentials;
        },

        getApiKey(credentials: OAuthCredentials): string {
          currentToken = credentials.access;
          currentTokenSource = "pi_oauth";
          return "cursor-native";
        },
      },
    });
  }
}
