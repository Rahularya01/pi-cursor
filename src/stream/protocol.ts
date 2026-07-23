/**
 * Protocol-drift helpers: auth error detection, decode error framing, client version.
 */
import { getCursorClientVersion } from "./config.js";

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

export function enhanceCursorStreamError(message: string): string {
  if (isAuthErrorMessage(message)) {
    return (
      `${message} ` +
      `[auth-hint: token may be expired. Idle stream retries force-refresh credentials; ` +
      `if this persists run /login cursor or check /cursor.doctor tokenSource.]`
    );
  }
  if (isProtocolMismatchMessage(message)) {
    return formatProtocolMismatchHint(message);
  }
  return message;
}
