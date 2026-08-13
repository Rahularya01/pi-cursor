/**
 * Curated context-window table for Cursor model families.
 *
 * Cursor's discovery RPCs do not carry a context window for every model
 * (`ModelDetails` has no such field at all), so the extension used to guess the
 * window from the display name and fell back to 200k for everything else. That
 * guess is wrong in both directions: Cursor names several rows "1M" while
 * capping the default window far lower, and it gives Grok 256k where the
 * fallback claimed 200k.
 *
 * Rules for this table:
 * - `defaultWindow` is Cursor's *default* context window, not the model's
 *   native window. Cursor may cap tighter than the provider does, and reporting
 *   a window that is too large is worse than one that is too small: Pi would
 *   never compact and would run into a server-side rejection instead.
 * - `maxModeWindow` is only set where Cursor documents that Max Mode unlocks a
 *   larger window. Families without a documented Max Mode window keep their
 *   default even when `max_mode` is requested.
 * - Every entry names its source. When in doubt, take the smaller documented
 *   value and say so in the entry comment.
 *
 * Primary source: Cursor's own per-model table ("Default Context" / "Max
 * Context") on https://cursor.com/docs/models-and-pricing, read 2026-08-13.
 */

export interface CursorContextWindowEntry {
  /** Model-id prefix, matched after stripping a leading `cursor-`. */
  readonly prefix: string;
  /** Cursor's default context window for this family. */
  readonly defaultWindow: number;
  /** Window Cursor unlocks with Max Mode, if it documents one. */
  readonly maxModeWindow?: number;
  /** Where the numbers come from. */
  readonly source: string;
}

/**
 * Window reported when neither the table nor the display-name heuristic matches.
 * This is Cursor's documented standard context window for normal mode.
 * Source: https://cursor.com/docs/models-and-pricing (Max Mode "extends a
 * model's context window beyond the default limit").
 */
export const CURSOR_FALLBACK_CONTEXT_WINDOW = 200_000;

const CURSOR_DOCS = "https://cursor.com/docs/models-and-pricing (read 2026-08-13)";

export const CURSOR_CONTEXT_WINDOWS: readonly CursorContextWindowEntry[] = [
  {
    prefix: "claude-fable-5",
    defaultWindow: 300_000,
    maxModeWindow: 1_000_000,
    source: CURSOR_DOCS,
  },
  {
    prefix: "claude-opus-5",
    defaultWindow: 300_000,
    maxModeWindow: 1_000_000,
    source: CURSOR_DOCS,
  },
  {
    prefix: "claude-sonnet-5",
    defaultWindow: 200_000,
    maxModeWindow: 1_000_000,
    source: CURSOR_DOCS,
  },
  // Composer 2.5 has no Max Context in Cursor's table.
  { prefix: "composer-2.5", defaultWindow: 200_000, source: CURSOR_DOCS },
  {
    prefix: "gemini-3.1-pro",
    defaultWindow: 200_000,
    maxModeWindow: 1_000_000,
    source: CURSOR_DOCS,
  },
  {
    prefix: "gemini-3.6-flash",
    defaultWindow: 200_000,
    maxModeWindow: 1_000_000,
    source: CURSOR_DOCS,
  },
  // Luna and Terra are listed with no Max Context, Sol with 1M.
  { prefix: "gpt-5.6-luna", defaultWindow: 272_000, source: CURSOR_DOCS },
  { prefix: "gpt-5.6-sol", defaultWindow: 272_000, maxModeWindow: 1_000_000, source: CURSOR_DOCS },
  { prefix: "gpt-5.6-terra", defaultWindow: 272_000, source: CURSOR_DOCS },
  // Cursor ships these as `cursor-grok-4.x-*`; no Max Context documented.
  { prefix: "grok-4.5", defaultWindow: 256_000, source: CURSOR_DOCS },
  { prefix: "grok-4.6", defaultWindow: 256_000, source: CURSOR_DOCS },
  {
    // Hidden-by-default model, so it is absent from the context table. Only the
    // Max Mode window is documented ("Up to 1M tokens with extended context",
    // "Requires Max Mode"); the default is assumed to be Cursor's standard
    // 200k, which is the conservative choice.
    prefix: "kimi-k3",
    defaultWindow: 200_000,
    maxModeWindow: 1_000_000,
    source: `${CURSOR_DOCS} — pricing notes only, default window unconfirmed`,
  },
] as const;

/**
 * Documented context window for a Cursor model id, or `undefined` when the
 * family is not in the table. Longest matching prefix wins.
 */
export function lookupCursorContextWindow(id: string, maxMode = false): number | undefined {
  const normalized = id.toLowerCase().replace(/^cursor-/, "");
  let best: CursorContextWindowEntry | undefined;
  for (const entry of CURSOR_CONTEXT_WINDOWS) {
    if (!normalized.startsWith(entry.prefix)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  if (!best) return undefined;
  return maxMode ? (best.maxModeWindow ?? best.defaultWindow) : best.defaultWindow;
}
