/**
 * Wire-protocol drift detection.
 *
 * Cursor can change `agent.v1` at any time, and the failure mode that costs the
 * most to debug is the quiet one: a server message case we don't know about is
 * skipped, nothing is answered, and the turn parks until the idle watchdog fires
 * with a generic timeout. The user sees "it hung"; the log says nothing.
 *
 * So every unrecognized case and every unknown protobuf field is recorded here
 * instead of being silently dropped. Signals are:
 *   - counted in-process and surfaced by `/cursor.doctor`
 *   - written to the always-on lifecycle log
 *   - appended to the stream error message when a turn actually fails
 *
 * Recording a signal is not itself an error. Unknown *fields* are routine when
 * Cursor ships ahead of our schema and are usually harmless. Unknown *message
 * cases* are the ones that strand a turn — `kind` keeps them distinguishable.
 */
import { lifecycleLog } from "./debug-log.js";
import { setLastDriftSignal } from "../diagnostics/diagnostics.js";

export type DriftKind =
  /** A top-level `AgentServerMessage.message` case we do not handle. */
  | "server_message"
  /** An `interactionUpdate` sub-case we do not handle. */
  | "interaction_update"
  /** A `kvServerMessage` sub-case we do not handle. */
  | "kv_message"
  /** An `interactionQuery` we could not answer. */
  | "interaction_query"
  /** An `execServerMessage` we could not answer — the stream may park. */
  | "exec_message"
  /** Fields present on the wire that our generated schema does not know. */
  | "unknown_fields";

/** Cases that can strand a turn, as opposed to being merely informational. */
const STRANDING_KINDS = new Set<DriftKind>([
  "server_message",
  "exec_message",
  "interaction_query",
  "kv_message",
]);

export interface DriftSignal {
  kind: DriftKind;
  detail: string;
  count: number;
  firstSeenIso: string;
  lastSeenIso: string;
}

const signals = new Map<string, DriftSignal>();

/** Bounded so a pathological stream cannot grow this map without limit. */
const MAX_TRACKED_SIGNALS = 64;

function signalKey(kind: DriftKind, detail: string): string {
  return `${kind}:${detail}`;
}

/**
 * Records one drift observation. Safe to call on a hot path: repeat observations
 * only bump a counter, and only the first of each kind+detail is logged.
 */
export function recordDriftSignal(kind: DriftKind, detail: string | undefined): void {
  const normalized = (detail ?? "unknown").slice(0, 80);
  const key = signalKey(kind, normalized);
  const now = new Date().toISOString();

  const existing = signals.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastSeenIso = now;
    return;
  }

  if (signals.size >= MAX_TRACKED_SIGNALS) return;
  signals.set(key, {
    kind,
    detail: normalized,
    count: 1,
    firstSeenIso: now,
    lastSeenIso: now,
  });

  // Log only on first sighting — a drifted stream would otherwise spam the log.
  lifecycleLog("wire_drift", { kind, detail: normalized, stranding: STRANDING_KINDS.has(kind) });
  setLastDriftSignal(`${kind}:${normalized}`);
}

/**
 * Records unknown protobuf fields on a decoded message. `$unknown` is populated
 * by @bufbuild/protobuf whenever the wire carries fields our schema lacks, which
 * is the earliest signal that `proto/agent.proto` is behind Cursor.
 */
export function recordUnknownFields(context: string, message: unknown): void {
  const unknown = (message as { $unknown?: readonly { no: number }[] } | null)?.$unknown;
  if (!unknown || unknown.length === 0) return;
  const fields = [...new Set(unknown.map((f) => f.no))].sort((a, b) => a - b).join(",");
  recordDriftSignal("unknown_fields", `${context}#${fields}`);
}

export function getDriftSignals(): DriftSignal[] {
  return [...signals.values()].sort((a, b) => b.count - a.count);
}

/** True when something was seen that can actually strand a turn. */
export function hasStrandingDrift(): boolean {
  return [...signals.values()].some((s) => STRANDING_KINDS.has(s.kind));
}

/** One-line summary for `/cursor.doctor` and error messages; empty when clean. */
export function formatDriftSummary(limit = 4): string {
  const all = getDriftSignals();
  if (all.length === 0) return "";
  const shown = all
    .slice(0, limit)
    .map((s) => `${s.kind}:${s.detail}${s.count > 1 ? `x${s.count}` : ""}`)
    .join(", ");
  const rest = all.length > limit ? ` (+${all.length - limit} more)` : "";
  return `${shown}${rest}`;
}

export function resetDriftSignalsForTests(): void {
  signals.clear();
}
