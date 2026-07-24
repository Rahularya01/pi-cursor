/**
 * Protocol-drift helpers: auth error detection, decode error framing, client version.
 */
import { getCursorClientVersion } from "./config.js";
import { formatDriftSummary, hasStrandingDrift } from "./drift.js";

const AUTH_ERROR_RE =
  /\b(unauthenticated|unauthorized|permission[_ ]?denied|auth(?:entication)?[_ ]?failed|invalid[_ ]?token|expired[_ ]?token|401)\b/i;

const PROTOCOL_ERROR_RE =
  /\b(failed to parse|decode|invalid wire|protocol|connect error|unknown field|premature eof)\b/i;

export function isAuthErrorMessage(message: string): boolean {
  return AUTH_ERROR_RE.test(message);
}

export function isProtocolMismatchMessage(message: string): boolean {
  return PROTOCOL_ERROR_RE.test(message);
}

export function formatProtocolMismatchHint(message: string): string {
  const version = getCursorClientVersion();
  return (
    `${message} ` +
    `[protocol-hint: Cursor wire may have drifted. ` +
    `clientVersion=${version}. Try bumping PI_CURSOR_CLIENT_VERSION or re-run /cursor.doctor.]`
  );
}

/**
 * Appends what actually drifted, when anything did.
 *
 * A turn that fails after we skipped an unrecognized server message would
 * otherwise surface as a bare timeout. Naming the unhandled case turns "it hung"
 * into a reproducible bug report.
 */
export function appendDriftDiagnostic(message: string): string {
  const summary = formatDriftSummary();
  if (!summary) return message;
  const severity = hasStrandingDrift()
    ? "unhandled wire messages — the turn may have been left waiting on one"
    : "unknown wire fields — schema is likely behind Cursor";
  return (
    `${message} ` +
    `[wire-drift: ${severity}. Observed: ${summary}. ` +
    `Regenerate the schema (see proto/README.md) or bump PI_CURSOR_CLIENT_VERSION; ` +
    `/cursor.doctor shows the full list.]`
  );
}

export function enhanceCursorStreamError(message: string): string {
  if (isAuthErrorMessage(message)) {
    return (
      `${message} ` +
      `[auth-hint: token may be expired. Idle stream retries force-refresh credentials; ` +
      `if this persists run /login cursor or check /cursor.doctor tokenSource.]`
    );
  }
  if (isProtocolMismatchMessage(message)) {
    return appendDriftDiagnostic(formatProtocolMismatchHint(message));
  }
  return appendDriftDiagnostic(message);
}
