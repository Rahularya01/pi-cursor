/**
 * Context-window and output-token ceilings for Cursor models.
 *
 * Cursor's `ModelDetails` carries neither number, so both are inferred from the
 * model id and display name. Kept in a dependency-free module because the model
 * catalog needs it at startup and must not drag the transport stack in with it.
 */

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/** GPT-5.6 default (272k short-context tier). */
export const GPT56_DEFAULT_CONTEXT_WINDOW = 272_000;

/**
 * OpenAI-via-Cursor GPT-5.6 (Luna / Sol / Terra) rejects prompts above this,
 * even when Cursor labels the row "1M" or advertises `context=1m`.
 * Observed: `maximum prompt length is 500000 but the request contains 503167`.
 */
export const GPT56_MAX_PROMPT_TOKENS = 500_000;

export function isGpt56Model(id: string, name = ""): boolean {
  return /gpt-5\.6/.test(`${id} ${name}`.toLowerCase());
}

/** Cap GPT-5.6 windows at the real OpenAI prompt limit; leave other families alone. */
export function clampCursorContextWindow(id: string, name: string, window: number): number {
  if (isGpt56Model(id, name) && window > GPT56_MAX_PROMPT_TOKENS) {
    return GPT56_MAX_PROMPT_TOKENS;
  }
  return window;
}

export function inferCursorContextWindow(id: string, name: string): number {
  const idLower = id.toLowerCase();
  const text = `${idLower} ${name}`.toLowerCase();

  // GPT-5.6 usable-model display names include "1M" even for the 272k default
  // (id `gpt-5.6-luna-high`, name "GPT-5.6 Luna 1M High"). Trust the id's `-1m`
  // marker, not the name, and never advertise more than the 500k prompt cap.
  if (isGpt56Model(id, name)) {
    if (/(?:^|-)1m(?:-|$)/.test(idLower)) return GPT56_MAX_PROMPT_TOKENS;
    return GPT56_DEFAULT_CONTEXT_WINDOW;
  }

  if (/\b1\s*m\b|(?:^|-)1m(?:-|$)/.test(text)) return 1_000_000;
  if (/\b272\s*k\b|(?:^|-)272k(?:-|$)/.test(text)) return 272_000;
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Pi-side budgeting metadata only: the Cursor run request has no max-output
 * field, so a wrong value here cannot fail a request upstream — it only
 * mis-sizes Pi's output allowance.
 *
 * Conservative by design. Only families whose provider documents a ceiling above
 * 64K are raised; everything else keeps the 64K floor Cursor's older models use.
 */
export function inferCursorMaxOutputTokens(id: string, name: string): number {
  const text = `${id} ${name}`.toLowerCase();
  // Claude 4.6 and newer (Opus/Sonnet) document a 128K output ceiling. Claude 4.5
  // and earlier — Haiku 4.5 included — stay at 64K.
  if (/claude-(?:[5-9]|4\.(?:[6-9]|\d{2,}))/.test(text)) return 128_000;
  // Cursor labels these "Opus 4.6" / "Sonnet 4.6" rather than "claude-4.6-*".
  if (/\b(?:sonnet|opus)\s*(?:[5-9]|4\.(?:[6-9]|\d{2,}))/.test(text)) return 128_000;
  if (/\bgpt-5/.test(text)) return 128_000;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}
