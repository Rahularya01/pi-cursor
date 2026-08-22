/**
 * Tuning knobs for the stream runtime: timeouts, retry budgets, and the
 * silence watchdog that backs them.
 *
 * Every `resolve*` function takes the raw env string so the parsing rules
 * (blank = default, 0 = disabled, floors on the rest) are unit-testable without
 * mutating `process.env`.
 */

export const CONVERSATION_TTL_MS = 30 * 60 * 1000;

export const DEFAULT_ACTIVE_BRIDGE_TTL_MS = 60 * 60 * 1000;

// Safety net against permanent hangs: if the upstream stream produces no progress
// for this long, the watchdog recovers/retries or ends the turn with a clear error
// instead of parking forever. Real work (textDelta, thinkingDelta, tokenDelta,
// tool-call events, answered interaction/exec) always resets it, and it is paused
// during tool execution — so long reasoning turns and slow tools are unaffected.
// Set the env vars to 0 to disable. 3 minutes: long pure-thinking stretches without
// tokenDelta still need headroom, while a true silent park should not hang forever.
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;

// A stream parked on an exec we could not answer is not slow, it is finished: Cursor
// waits for a reply that will never arrive while its heartbeats keep the connection
// alive. Liveness stops counting as progress once that happens (see StreamProgress),
// and this shorter deadline gives the generic ExecClientThrow answer time to unpark
// the run before the turn is failed.
export const DEFAULT_STREAM_PARK_TIMEOUT_MS = 45_000;

export const DEFAULT_RESUME_IDLE_TIMEOUT_MS = 180_000;

// More generations for multi-hour agent sessions; each attempt can force-refresh auth.
export const DEFAULT_STREAM_IDLE_MAX_RETRIES = 5;

export const DEFAULT_MIDPAUSE_REBUILD_MAX_AGE_MS = 15 * 60 * 1000;

/** Soft cap on retained blob bytes per conversation (images + turn blobs). */
export const MAX_CONVERSATION_BLOB_BYTES = 128 * 1024 * 1024;
export const MAX_ACTIVE_BLOB_BYTES = MAX_CONVERSATION_BLOB_BYTES;
// Entry bound, evicted oldest-first alongside the byte bound. Turn blobs run a
// couple of KB, so this is reached long before the byte cap on any conversation
// that lives for a few hundred tool calls; it bounds Map overhead, and matches
// the number of blobs the run journal is willing to persist.
export const MAX_ACTIVE_BLOB_ENTRIES = 512;
export const MAX_INDIVIDUAL_BLOB_BYTES = 32 * 1024 * 1024;

/**
 * Hard cap on a stored upstream checkpoint's byte size. Unlike blobs and tool
 * results, the checkpoint Cursor hands back is opaque and unbounded — over a
 * long-running conversation it can grow past the transport's 64 MiB Connect
 * frame limit, at which point the checkpoint would fail every future turn
 * (frameConnectMessage throws before anything is sent). Discarding it above
 * this cap forces a rebuild from the (bounded) blob store instead, leaving
 * plenty of headroom under the transport limit for mcpTools/model metadata.
 */
export const MAX_CHECKPOINT_BYTES = 48 * 1024 * 1024;

export const DEFAULT_H2_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Activity idle kill after first I/O. Default 0 (disabled): parent heartbeats
 * already keep the bridge alive, and a hard idle kill during long tool pauses
 * was a common source of "Bridge connection lost" mid-session. Set
 * PI_CURSOR_H2_IDLE_TIMEOUT_MS to re-enable a safety net.
 */
export const DEFAULT_H2_IDLE_TIMEOUT_MS = 0;

export function resolveActiveBridgeTtlMs(envValue?: string): number {
  if (envValue === undefined || envValue === "") return DEFAULT_ACTIVE_BRIDGE_TTL_MS;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed)) return DEFAULT_ACTIVE_BRIDGE_TTL_MS;
  return Math.max(1_000, parsed);
}

export function resolveStreamIdleTimeoutMs(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (parsed === 0) return 0;
  return Math.max(1_000, Math.floor(parsed));
}

export function resolveStreamIdleMaxRetries(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_STREAM_IDLE_MAX_RETRIES;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STREAM_IDLE_MAX_RETRIES;
  if (parsed === 0) return 0;
  return Math.min(10, Math.max(1, Math.floor(parsed)));
}

export function resolveResumeIdleTimeoutMs(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_RESUME_IDLE_TIMEOUT_MS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RESUME_IDLE_TIMEOUT_MS;
  if (parsed === 0) return 0;
  return Math.max(1_000, Math.floor(parsed));
}

export function resolveH2ConnectTimeoutMs(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_H2_CONNECT_TIMEOUT_MS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_H2_CONNECT_TIMEOUT_MS;
  if (parsed === 0) return 0;
  return Math.max(1_000, Math.floor(parsed));
}

export function resolveH2IdleTimeoutMs(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_H2_IDLE_TIMEOUT_MS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_H2_IDLE_TIMEOUT_MS;
  if (parsed === 0) return 0;
  return Math.max(5_000, Math.floor(parsed));
}

/**
 * What a server message says about the stream.
 *
 * `work` is the run moving: tokens, tool calls, answered execs, checkpoints.
 * `liveness` is the connection breathing while the run itself may be stuck —
 * a heartbeat proves the socket, not the turn. `none` is noise.
 *
 * The distinction exists because a park is not silent: Cursor keeps heartbeating
 * a run that is waiting for an exec reply we never sent, which made a
 * silence-only watchdog unable to ever fire (a Grok session sat parked for 90
 * minutes on an unknown exec case in 2026-08).
 */
export type StreamProgress = "none" | "liveness" | "work";

/**
 * How an interaction-update case should be treated by the stream idle watchdog.
 * tokenDelta is work: long reasoning turns emit it without text for minutes at a
 * time, and it only flows while the model is actually generating.
 */
export function interactionUpdateProgress(
  updateCase: string | undefined,
  hasNonEmptyText = false,
): StreamProgress {
  if (updateCase === "textDelta" || updateCase === "thinkingDelta")
    return hasNonEmptyText ? "work" : "none";
  if (updateCase === "heartbeat") return "liveness";
  if (updateCase === "tokenDelta") return "work";
  if (updateCase === "toolCallCompleted") return "work";
  if (updateCase === "toolCallStarted") return "work";
  if (updateCase === "partialToolCall") return "work";
  if (updateCase === "toolCallDelta") return "work";
  if (updateCase === "thinkingCompleted") return "work";
  if (
    updateCase === "summary" ||
    updateCase === "summaryStarted" ||
    updateCase === "summaryCompleted"
  )
    return "work";
  return "none";
}

/** Whether a blind full-request restart is safe given already-streamed content. */
export function canBlindIdleRestart(emittedUserVisibleContent: boolean): boolean {
  return !emittedUserVisibleContent;
}

/**
 * Whether recovery is allowed after transport loss.
 * Blind restart only when nothing was streamed; checkpoint continuation is safe
 * even after partial text because Cursor resumes server-side state and emits
 * only new tokens (Pi appends them to the existing writer).
 */
export function canRecoverAfterTransportLoss(input: {
  emittedUserVisibleContent: boolean;
  hasCheckpoint: boolean;
}): boolean {
  if (!input.emittedUserVisibleContent) return true;
  return input.hasCheckpoint;
}

export function resolveMidPauseRebuildMaxAgeMs(envValue?: string): number {
  const normalized = envValue?.trim();
  if (normalized === undefined || normalized === "") return DEFAULT_MIDPAUSE_REBUILD_MAX_AGE_MS;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MIDPAUSE_REBUILD_MAX_AGE_MS;
  // Zero should keep the replay trust window bounded; negative values are treated as invalid.
  return Math.max(1_000, Math.floor(parsed));
}

export function createStreamIdleWatchdog(options: { timeoutMs: number; onTimeout: () => void }): {
  start(): void;
  reset(): void;
  pause(): void;
  resume(): void;
  clear(): void;
  setTimeoutMs(timeoutMs: number): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let paused = false;
  let fired = false;
  let timeoutMs = options.timeoutMs;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const arm = () => {
    clear();
    if (timeoutMs <= 0 || paused || fired) return;
    timer = setTimeout(() => {
      timer = undefined;
      fired = true;
      options.onTimeout();
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    start() {
      if (started) return;
      started = true;
      paused = false;
      arm();
    },
    reset() {
      if (paused || fired) return;
      arm();
    },
    pause() {
      paused = true;
      clear();
    },
    resume() {
      if (fired) return;
      paused = false;
      arm();
    },
    setTimeoutMs(next: number) {
      if (next === timeoutMs) return;
      timeoutMs = next;
      if (started) arm();
    },
    clear,
  };
}

export const ACTIVE_BRIDGE_TTL_MS = resolveActiveBridgeTtlMs(
  process.env.PI_CURSOR_ACTIVE_BRIDGE_TTL_MS,
);
