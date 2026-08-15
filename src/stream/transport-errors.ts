/**
 * Structured classification for Cursor transport failures.
 *
 * Callers use this to decide whether a bridge death / Connect error is safe to
 * recover from (new generation + checkpoint/history) versus permanent.
 */

import { TransportFailureKind } from "../types/enums.js";

export { TransportFailureKind };

export interface TransportFailure {
  kind: TransportFailureKind;
  /** Whether a new stream generation may be attempted. */
  retryable: boolean;
  /** Prefer force-refreshing credentials before the next attempt. */
  refreshAuth: boolean;
  /** Human-readable summary (secrets must already be redacted by caller). */
  message: string;
  /** Optional raw bridge exit code. */
  exitCode?: number;
  /** Optional child stderr tail. */
  stderr?: string;
}

const AUTH_RE =
  /\b(401|403|unauthenticated|unauthorized|forbidden|invalid[_ ]token|token (?:expired|revoked)|auth(?:entication|orization) (?:failed|error))\b/i;
const RATE_RE = /\b(429|resource_exhausted|rate[_ ]?limit|too many requests)\b/i;
const GOAWAY_RE = /\bGOAWAY\b/i;
const RESET_RE = /\b(ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|connection reset)\b/i;
const TIMEOUT_RE = /\b(ETIMEDOUT|timed? ?out|timeout)\b/i;
const PROTOCOL_RE = /\b(protocol|protobuf|wire drift|invalid argument|failed_precondition)\b/i;

export function classifyBridgeExit(input: {
  exitCode: number;
  stderr?: string;
  endErrorMessage?: string;
}): TransportFailure {
  const stderr = (input.stderr || "").trim();
  const endError = (input.endErrorMessage || "").trim();
  const combined = [endError, stderr].filter(Boolean).join(" | ");

  if (input.exitCode === 2 || GOAWAY_RE.test(combined)) {
    return {
      kind: TransportFailureKind.Goaway,
      retryable: true,
      refreshAuth: false,
      message: combined
        ? `Cursor upstream closed the connection (GOAWAY): ${combined}`
        : "Cursor upstream closed the connection (GOAWAY).",
      exitCode: input.exitCode,
      stderr: stderr || undefined,
    };
  }

  if (AUTH_RE.test(combined)) {
    return {
      kind: TransportFailureKind.Authentication,
      retryable: true,
      refreshAuth: true,
      message: combined || "Cursor authentication failed.",
      exitCode: input.exitCode,
      stderr: stderr || undefined,
    };
  }

  if (RATE_RE.test(combined)) {
    return {
      kind: TransportFailureKind.RateLimit,
      retryable: true,
      refreshAuth: false,
      message: combined || "Cursor rate limited the request.",
      exitCode: input.exitCode,
      stderr: stderr || undefined,
    };
  }

  if (TIMEOUT_RE.test(combined)) {
    return {
      kind: TransportFailureKind.SocketTimeout,
      retryable: true,
      refreshAuth: false,
      message: combined || "Cursor transport timed out.",
      exitCode: input.exitCode,
      stderr: stderr || undefined,
    };
  }

  if (RESET_RE.test(combined)) {
    return {
      kind: TransportFailureKind.ConnectionReset,
      retryable: true,
      refreshAuth: false,
      message: combined || "Cursor connection was reset.",
      exitCode: input.exitCode,
      stderr: stderr || undefined,
    };
  }

  if (PROTOCOL_RE.test(combined)) {
    return {
      kind: TransportFailureKind.ProtocolDrift,
      retryable: false,
      refreshAuth: false,
      message: combined || "Cursor protocol mismatch.",
      exitCode: input.exitCode,
      stderr: stderr || undefined,
    };
  }

  if (input.exitCode !== 0) {
    return {
      kind: TransportFailureKind.BridgeCrash,
      retryable: true,
      refreshAuth: false,
      message: combined
        ? `Bridge connection lost (exit ${input.exitCode}): ${combined}`
        : `Bridge connection lost (exit ${input.exitCode}).`,
      exitCode: input.exitCode,
      stderr: stderr || undefined,
    };
  }

  return {
    kind: TransportFailureKind.Unknown,
    retryable: false,
    refreshAuth: false,
    message: combined || "Bridge closed cleanly.",
    exitCode: input.exitCode,
    stderr: stderr || undefined,
  };
}

export function formatTransportFailure(failure: TransportFailure): string {
  const hints: string[] = [];
  if (failure.retryable) {
    hints.push("A checkpoint/history recovery may continue the turn.");
  }
  if (failure.refreshAuth) {
    hints.push("Token may need refresh — run /login cursor or check /cursor.doctor tokenSource.");
  }
  if (failure.kind === TransportFailureKind.ProtocolDrift) {
    hints.push("Pin PI_CURSOR_CLIENT_VERSION or regenerate proto if wire drift persists.");
  }
  return hints.length ? `${failure.message} ${hints.join(" ")}` : failure.message;
}

/** Synthetic user text used when resuming a run after transport loss with a checkpoint. */
export const CHECKPOINT_CONTINUATION_PROMPT =
  "[pi-cursor] The previous upstream stream was interrupted. Continue exactly where you left off. Do not repeat content already produced.";
