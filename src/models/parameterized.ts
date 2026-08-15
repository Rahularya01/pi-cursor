/**
 * Parameterized Cursor models metadata conversion and catalog augmentation.
 */

import rawFallbackModels from "./catalog.json" with { type: "json" };
import type {
  CursorModelParameter,
  CursorParameterizedModel,
  CursorParameterizedVariant,
} from "../client/cursor-wire.js";
import type { CursorModel } from "../stream/model-discovery.js";
import { supportsReasoningModelId } from "./processing.js";

export const GPT55_VARIANTS = [
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

export const GPT55_REASONING_LEVELS = [
  { suffix: "none", label: "None", value: "none" },
  { suffix: "low", label: "Low", value: "low" },
  { suffix: "medium", label: "", value: "medium" },
  { suffix: "high", label: "High", value: "high" },
  { suffix: "extra-high", label: "Extra High", value: "extra-high" },
] as const;

export function gpt55ParameterizedModels(): CursorModel[] {
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

export function parameterValue(parameters: CursorModelParameter[], id: string): string | undefined {
  return parameters.find((parameter) => parameter.id === id)?.value;
}

export function contextWindowFromParameter(
  context: string | undefined,
  fallback = 200_000,
): number {
  if (context === "272k") return 272_000;
  if (context === "1m") return 1_000_000;
  const k = context?.match(/^(\d+)k$/i)?.[1];
  if (k) return Number(k) * 1_000;
  const m = context?.match(/^(\d+)m$/i)?.[1];
  if (m) return Number(m) * 1_000_000;
  return fallback;
}

export function cursorEffortSuffix(value: string): string {
  return value;
}

export function cursorEffortLabel(value: string): string {
  return (
    GPT55_REASONING_LEVELS.find((level) => level.value === value)?.label ||
    ({ xhigh: "Extra High", max: "Max", none: "None" } as Record<string, string>)[value] ||
    value.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

export function metadataEffortParameterId(
  variant: CursorParameterizedVariant,
): "reasoning" | "effort" | undefined {
  if (variant.parameters.some((parameter) => parameter.id === "reasoning")) return "reasoning";
  if (variant.parameters.some((parameter) => parameter.id === "effort")) return "effort";
  return undefined;
}

export function isDefaultContext(context: string | undefined): boolean {
  if (!context) return true;
  return context === "200k" || context === "272k" || context === "300k";
}

export function contextIdPart(context: string | undefined): string {
  return context && !isDefaultContext(context) ? `-${context.toLowerCase()}` : "";
}

export function contextLabel(context: string | undefined): string | undefined {
  if (!context || isDefaultContext(context)) return undefined;
  return context.toUpperCase();
}

export function maxModeIdPart(
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

export function maxModeLabel(
  modelName: string,
  context: string | undefined,
  requestedMaxMode: boolean,
  hasEffortParameter: boolean,
): string | undefined {
  const idPart = maxModeIdPart(modelName, context, requestedMaxMode, hasEffortParameter);
  if (!idPart) return undefined;
  return idPart === "-max-mode" ? "Max Mode" : "Max";
}

export function parameterizedBaseId(
  modelName: string,
  variant: CursorParameterizedVariant,
  requestedMaxMode: boolean,
  hasEffortParameter: boolean,
): string {
  const context = parameterValue(variant.parameters, "context");
  return `${modelName}${contextIdPart(context)}${maxModeIdPart(modelName, context, requestedMaxMode, hasEffortParameter)}`;
}

export function parameterizedBaseLabel(
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

export function hasVariantParameterSet(
  model: CursorParameterizedModel,
  parameters: CursorModelParameter[],
): boolean {
  const normalized = normalizeParameterValues(parameters);
  return model.variants.some(
    (variant) => normalizeParameterValues(variant.parameters) === normalized,
  );
}

export function normalizeParameterValues(parameters: CursorModelParameter[]): string {
  return parameters
    .map((parameter) => `${parameter.id}=${parameter.value}`)
    .sort((a, b) => a.localeCompare(b))
    .join(";");
}

export function buildParameterizedRowsFromGroup(options: {
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
      ? `${baseId}-${cursorEffortSuffix(effort ?? "")}${thinking ? "-thinking" : ""}${fast ? "-fast" : ""}`
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

export function parameterGroupKey(
  variant: CursorParameterizedVariant,
  effortParameterId?: string,
): string {
  const params = variant.parameters
    .filter((parameter) => parameter.id !== effortParameterId)
    .map((parameter) => `${parameter.id}=${parameter.value}`)
    .sort((a, b) => a.localeCompare(b))
    .join(";");
  return `${variant.isMaxMode ? "max" : "nonmax"}|${params}`;
}

export function shouldGenerateSyntheticMaxRows(
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

export function normalizeDisplayModel(model: CursorModel): CursorModel {
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
