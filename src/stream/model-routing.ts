/**
 * Model ID effort suffix routing for Cursor runtime variants.
 */

export interface CursorNativeModelRouting {
  modelId: string;
  parameters?: Array<{ id: string; value: string }>;
  requiresMaxMode?: boolean;
  requestedMaxMode?: boolean;
}

export interface ResolvedCursorModelRouting extends CursorNativeModelRouting {
  maxMode: boolean;
}

type CursorModelRoutingByEffort = Record<string, CursorNativeModelRouting>;

export interface CursorResolvableModel {
  id: string;
  [key: string]: unknown;
}

/**
 * Insert reasoning effort into model ID, before -fast/-thinking suffix.
 * e.g. model="gpt-5.4" + effort="medium" → "gpt-5.4-medium"
 *      model="gpt-5.4-fast" + effort="high" → "gpt-5.4-high-fast"
 * If no effort provided, returns model as-is.
 */
export function resolveModelId(model: string, reasoningEffort?: string): string {
  if (!reasoningEffort) return model;

  let suffix = "";
  let base = model;
  if (base.endsWith("-fast")) {
    suffix = "-fast";
    base = base.slice(0, -5);
  } else if (base.endsWith("-thinking")) {
    suffix = "-thinking";
    base = base.slice(0, -9);
  }

  return `${base}-${reasoningEffort}${suffix}`;
}

function isCursorModelRouting(value: unknown): value is CursorNativeModelRouting {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { modelId?: unknown }).modelId === "string"
  );
}

export function resolveRequestedModelId(
  model: string,
  reasoningEffort?: string,
  cursorModelId?: string,
): string;
export function resolveRequestedModelId(
  model: CursorResolvableModel,
  reasoningEffort?: string,
  routingByModelId?: Map<string, CursorModelRoutingByEffort | CursorNativeModelRouting>,
): ResolvedCursorModelRouting;
export function resolveRequestedModelId(
  model: string | CursorResolvableModel,
  reasoningEffort?: string,
  cursorModelIdOrRoutingByModelId?:
    string | Map<string, CursorModelRoutingByEffort | CursorNativeModelRouting>,
): string | ResolvedCursorModelRouting {
  if (typeof model === "string") {
    const trimmedCursorModelId =
      typeof cursorModelIdOrRoutingByModelId === "string"
        ? cursorModelIdOrRoutingByModelId.trim()
        : "";
    if (trimmedCursorModelId) return trimmedCursorModelId;
    return resolveModelId(model, reasoningEffort);
  }

  const routingByModelId =
    cursorModelIdOrRoutingByModelId instanceof Map ? cursorModelIdOrRoutingByModelId : undefined;
  const configured = routingByModelId?.get(model.id);
  let routing: CursorNativeModelRouting | undefined;
  if (isCursorModelRouting(configured)) {
    routing = configured;
  } else if (configured) {
    routing =
      configured[reasoningEffort ?? ""] ??
      configured.none ??
      configured.medium ??
      configured.high ??
      Object.values(configured).find(isCursorModelRouting);
  }

  return {
    modelId: routing?.modelId ?? resolveModelId(model.id, reasoningEffort),
    maxMode: Boolean(routing?.requestedMaxMode ?? routing?.requiresMaxMode),
    parameters: routing?.parameters,
    requestedMaxMode: routing?.requestedMaxMode,
    requiresMaxMode: routing?.requiresMaxMode,
  };
}
