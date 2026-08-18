/**
 * Context-window and output-token ceilings for Cursor models.
 *
 * Cursor's `ModelDetails` carries neither number, so both are inferred from the
 * model id and display name. Kept in a dependency-free module because the model
 * catalog needs it at startup and must not drag the transport stack in with it.
 */

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

export function inferCursorContextWindow(id: string, name: string): number {
  const text = `${id} ${name}`.toLowerCase();
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
