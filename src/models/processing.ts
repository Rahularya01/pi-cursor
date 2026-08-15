/**
 * Model parsing, effort mapping, and routing lookups.
 */

import type { CursorModel } from "../stream/model-discovery.js";
import type { CursorNativeModelRouting } from "../stream/model-routing.js";
import { estimateModelCost } from "./cost.js";
import { ProviderConstant, type PiThinkingLevel } from "../types/enums.js";

export type CursorModelRouting = CursorNativeModelRouting;

export const CURSOR_EFFORT_SUFFIXES: Array<{ suffix: string; effort: string }> = [
  { suffix: "extra-high", effort: "xhigh" },
  { suffix: "minimal", effort: "minimal" },
  { suffix: "xhigh", effort: "xhigh" },
  { suffix: "medium", effort: "medium" },
  { suffix: "high", effort: "high" },
  { suffix: "low", effort: "low" },
  { suffix: "max", effort: "max" },
  { suffix: "none", effort: "none" },
];

export type CursorEffortMap = Record<PiThinkingLevel, string | null>;

export interface ParsedModelId {
  base: string; // model ID with effort stripped
  effort: string; // effort level, or "" if no effort suffix
  fast: boolean; // has -fast suffix
  thinking: boolean; // has -thinking suffix
}

export function stripEffortSuffix(id: string): { remaining: string; effort: string } {
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
  if (thinkingLevel !== "off") {
    return;
  }
  if (payload.reasoning_effort !== undefined || typeof payload.model !== "string") {
    return;
  }
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
    const hasOnlyEffortVariants = effortNames.size === 1 && ![...effortNames][0]!.trim().length;
    const shouldDedup = effortNames.size >= 2 || !hasOnlyEffortVariants;
    if (shouldDedup && (effortNames.size >= 2 || [...effortNames][0] !== "")) {
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
    // Keep api explicit on every model so session restore / models.json merges
    // cannot strand rows on a different transport id.
    api: ProviderConstant.NativeApi,
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
