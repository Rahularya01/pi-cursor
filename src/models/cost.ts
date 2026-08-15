/**
 * Model token pricing and cost estimation table.
 */

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_COST_TABLE: Record<string, ModelCost> = {
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

export const DEFAULT_COST: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 };

export const MODEL_COST_PATTERNS: Array<{ match: (id: string) => boolean; cost: ModelCost }> = [
  {
    match: (id) => /claude.*opus.*fast/i.test(id),
    cost: { input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 },
  },
  {
    match: (id) => /claude.*opus/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-opus"] ?? DEFAULT_COST,
  },
  {
    match: (id) => /claude.*haiku/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.5-haiku"] ?? DEFAULT_COST,
  },
  {
    match: (id) => /claude.*sonnet/i.test(id),
    cost: MODEL_COST_TABLE["claude-4.6-sonnet"] ?? DEFAULT_COST,
  },
  { match: (id) => /composer/i.test(id), cost: MODEL_COST_TABLE["composer-1"] ?? DEFAULT_COST },
  { match: (id) => /gpt-5\.5/i.test(id), cost: MODEL_COST_TABLE["gpt-5.5"] ?? DEFAULT_COST },
  {
    match: (id) => /gpt-5\.4.*mini/i.test(id),
    cost: MODEL_COST_TABLE["gpt-5.4-mini"] ?? DEFAULT_COST,
  },
  { match: (id) => /gpt-5\.4/i.test(id), cost: MODEL_COST_TABLE["gpt-5.4"] ?? DEFAULT_COST },
  { match: (id) => /gpt-5\.3/i.test(id), cost: MODEL_COST_TABLE["gpt-5.3-codex"] ?? DEFAULT_COST },
  { match: (id) => /gpt-5\.2/i.test(id), cost: MODEL_COST_TABLE["gpt-5.2"] ?? DEFAULT_COST },
  { match: (id) => /gpt-5.*mini/i.test(id), cost: MODEL_COST_TABLE["gpt-5-mini"] ?? DEFAULT_COST },
  { match: (id) => /gpt-5/i.test(id), cost: MODEL_COST_TABLE["gpt-5"] ?? DEFAULT_COST },
  {
    match: (id) => /gemini.*3\.1/i.test(id),
    cost: MODEL_COST_TABLE["gemini-3.1-pro"] ?? DEFAULT_COST,
  },
  {
    match: (id) => /gemini.*flash/i.test(id),
    cost: MODEL_COST_TABLE["gemini-2.5-flash"] ?? DEFAULT_COST,
  },
  { match: (id) => /gemini/i.test(id), cost: MODEL_COST_TABLE["gemini-3-pro"] ?? DEFAULT_COST },
  { match: (id) => /grok/i.test(id), cost: MODEL_COST_TABLE["grok-4.20"] ?? DEFAULT_COST },
  { match: (id) => /kimi/i.test(id), cost: MODEL_COST_TABLE["kimi-k2.5"] ?? DEFAULT_COST },
];

export function estimateModelCost(modelId: string): ModelCost {
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
