/**
 * In-process HTTP/2 transport for Cursor's Connect RPCs — streaming (bidirectional) and unary.
 *
 * Replaces the old h2-bridge.mjs Node child process. That subprocess existed because Bun's
 * `node:http2` client was believed unable to carry a bidirectional Connect stream reliably.
 * oh-my-pi (github.com/can1357/oh-my-pi, packages/ai/src/providers/cursor.ts) demonstrates the
 * same bidirectional Connect-stream pattern working directly in-process under Bun — writes
 * (heartbeats, interaction responses, exec results) interleaved with reads throughout the
 * stream's life, no subprocess. Its only documented Bun/H2 caveat is ALPN negotiation failing
 * behind an ALPN-stripping TLS proxy (ported below as `describeH2TransportError`) — an
 * environment issue, not a bidirectional-streaming bug.
 *
 * This module reproduces h2-bridge.mjs's exact externally observable protocol — the same
 * onData frames and onClose exit codes for the same conditions (clean end, non-2xx status,
 * GOAWAY, transport error, idle/connect timeout) — just as direct in-process event wiring
 * instead of a length-prefixed pipe to a child process. Every consumer (bridge-session.ts,
 * native-core.ts, model-discovery.ts) drives the `BridgeHandle` interface and does not care which
 * transport is behind it, so this is a byte-for-byte behavioral port, not a redesign: keeping
 * that behavior identical is what keeps the retry/recovery logic downstream correct unchanged.
 */
import http2 from "node:http2";
import { randomUUID } from "node:crypto";

import { getCursorClientVersion } from "../config/index.js";
import { ConnectFlag } from "../types/enums.js";
import {
  MAX_BRIDGE_MESSAGE_BYTES,
  type BridgeDebugLog,
  type BridgeHandle,
  type SpawnBridgeOptions,
} from "./bridge.js";

const CURSOR_API_URL = "https://api2.cursor.sh";
const MAX_ERROR_BODY_BYTES = 1024 * 1024;
/** Grace window given to a stream to finish flushing trailing data after `end()` before the
 *  session is forced closed — mirrors h2-bridge.mjs's shutdown delay. */
const END_GRACE_MS = 100;
/** HTTP/2 PING interval: keeps intermediary/load-balancer sessions alive during long pure-thinking
 *  stretches where no DATA frames flow. Cursor may otherwise GOAWAY the stream mid-turn. */
const PING_INTERVAL_MS = 20_000;

/** ms; 0 disables. Invalid/missing/negative falls back to `fallback`. */
function optionalMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  if (value === 0) return 0;
  return Math.floor(value);
}

function connectEndStreamErrorFrame(code: string, message: string): Buffer {
  const payload = Buffer.from(JSON.stringify({ error: { code, message } }), "utf8");
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = ConnectFlag.EndStream;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

/**
 * Maps an opaque HTTP/2 negotiation failure into an actionable diagnostic message.
 *
 * Ported from oh-my-pi's `mapH2TransportError`: an ALPN-stripping TLS-intercepting proxy (e.g.
 * Zscaler) causes the TLS handshake to negotiate no `h2` protocol, and the HTTP/2 client throws
 * `ERR_HTTP2_ERROR: h2 is not supported`. Cursor's RPCs are HTTP/2-only, so there is no h1
 * fallback — the call simply cannot proceed. Non-ALPN errors pass through untouched.
 */
export function describeH2TransportError(error: unknown, baseUrl: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ERR_HTTP2_ERROR" && /h2 is not supported/i.test(message)) {
    return (
      `Cursor transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
      "This host serves Cursor's RPCs over HTTP/2 only, and the TLS handshake did not negotiate " +
      "h2 via ALPN — typically an ALPN-stripping TLS-intercepting proxy (e.g. Zscaler)."
    );
  }
  return message;
}

function buildRequestHeaders(
  rpcPath: string,
  unary: boolean,
  token: string,
): http2.OutgoingHttpHeaders {
  return {
    ":method": "POST",
    ":path": rpcPath,
    "content-type": unary ? "application/proto" : "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${token}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": getCursorClientVersion(),
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  };
}

/** The slice of `http2.ClientHttp2Session` this module depends on — narrowed so tests can inject
 *  a fake session without standing up a real TLS/H2 connection. */
export type H2Session = Pick<http2.ClientHttp2Session, "request" | "on" | "close" | "destroy"> & {
  readonly destroyed: boolean;
  readonly closed: boolean;
  ping?(callback: (err: Error | null) => void): void;
};

/** The slice of `http2.ClientHttp2Stream` this module depends on. */
export type H2Stream = Pick<
  http2.ClientHttp2Stream,
  "write" | "end" | "on" | "destroy" | "close"
> & {
  readonly destroyed: boolean;
  readonly closed: boolean;
  readonly writableLength: number;
};

/**
 * Builds a `BridgeHandle` on top of an already-connected `H2Session`. Split out from
 * `createInProcessBridge` so tests can drive the state machine against a fake session/stream pair
 * instead of a real HTTP/2 connection — the same seam `createBridgeHandleForChild` used to provide
 * for the subprocess implementation.
 */
export function createBridgeHandleForSession(
  session: H2Session,
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog,
): BridgeHandle {
  const baseUrl = options.url ?? CURSOR_API_URL;
  const rpcPath = options.rpcPath;
  const unary = options.unary ?? false;
  const persistent = unary ? false : options.persistent === true;
  const connectTimeoutMs = optionalMs(options.connectTimeoutMs, 30_000);
  const idleTimeoutMs = optionalMs(options.idleTimeoutMs, 0);

  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    close: null as ((code: number) => void) | null,
    streamDone: null as (() => void) | null,
  };
  const queuedData: Buffer[] = [];
  let queuedDataBytes = 0;
  let queuedStreamDone = false;

  let exited = false;
  let stderrTail = "";
  const appendDiagnostic = (line: string): void => {
    stderrTail = `${stderrTail}\n${line}`.slice(-8_000);
  };

  let currentStream: H2Stream | null = null;
  let exitCode = 1;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let endGraceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearWatchdog = (): void => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  };
  const armWatchdog = (ms: number): void => {
    clearWatchdog();
    if (!ms || ms <= 0) return;
    watchdogTimer = setTimeout(() => {
      appendDiagnostic("[h2-session] connect/idle timeout");
      debugLog("bridge.watchdog_timeout", { rpcPath });
      destroySession();
      finalizeExit(1);
    }, ms);
    watchdogTimer.unref?.();
  };
  const resetIdleWatchdog = (): void => armWatchdog(idleTimeoutMs);

  const destroySession = (): void => {
    clearWatchdog();
    if (pingTimer) clearInterval(pingTimer);
    if (endGraceTimer) clearTimeout(endGraceTimer);
    try {
      session.destroy();
    } catch {
      // Already destroyed.
    }
  };

  const finalizeExit = (code: number): void => {
    if (exited) return;
    exited = true;
    exitCode = code;
    clearWatchdog();
    if (pingTimer) clearInterval(pingTimer);
    if (endGraceTimer) clearTimeout(endGraceTimer);
    try {
      cbs.close?.(code);
    } catch (error) {
      debugLog("bridge.close_callback_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const deliverData = (payload: Buffer): void => {
    if (!cbs.data) {
      queuedDataBytes += payload.byteLength;
      if (queuedDataBytes > MAX_BRIDGE_MESSAGE_BYTES) {
        debugLog("bridge.prelistener_buffer_limit", { queuedDataBytes });
        destroySession();
        finalizeExit(1);
        return;
      }
      queuedData.push(payload);
      return;
    }
    try {
      cbs.data(payload);
    } catch (error) {
      debugLog("bridge.data_callback_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      destroySession();
      finalizeExit(1);
    }
  };

  const deliverStreamDone = (): void => {
    if (!cbs.streamDone) {
      queuedStreamDone = true;
      return;
    }
    try {
      cbs.streamDone();
    } catch (error) {
      debugLog("bridge.stream_done_callback_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      destroySession();
      finalizeExit(1);
    }
  };

  function attachStream(stream: H2Stream): void {
    currentStream = stream;
    let responseStatus = 0;
    let responseStatusText = "";
    const errorChunks: Buffer[] = [];
    let errorBodyBytes = 0;
    const isErrorStatus = (): boolean =>
      responseStatus !== 0 && (responseStatus < 200 || responseStatus >= 300);

    stream.on("response", (headers: http2.IncomingHttpHeaders) => {
      resetIdleWatchdog();
      responseStatus = Number(headers[":status"] || 0);
      responseStatusText = String(
        headers["grpc-message"] ?? headers["connect-error-message"] ?? "",
      );
    });

    stream.on("data", (chunk: Buffer) => {
      resetIdleWatchdog();
      if (isErrorStatus()) {
        const remaining = MAX_ERROR_BODY_BYTES - errorBodyBytes;
        if (remaining > 0) {
          const kept = Buffer.from(chunk).subarray(0, remaining);
          errorChunks.push(kept);
          errorBodyBytes += kept.byteLength;
        }
        return;
      }
      deliverData(Buffer.from(chunk));
    });

    stream.on("end", () => {
      if (exited) return;
      if (isErrorStatus()) {
        const body = Buffer.concat(errorChunks).toString("utf8").trim();
        const detail = responseStatusText || body || "HTTP/2 upstream request failed";
        deliverData(
          connectEndStreamErrorFrame(
            `http_${responseStatus}`,
            `Cursor HTTP ${responseStatus}: ${detail}`,
          ),
        );
        destroySession();
        finalizeExit(1);
        return;
      }
      currentStream = null;
      if (persistent) {
        deliverStreamDone();
        return;
      }
      finalizeExit(0);
    });

    stream.on("error", (error: Error) => {
      if (exited) return;
      appendDiagnostic(`[h2-session] stream error: ${error.message}`);
      debugLog("bridge.stream_error", { message: error.message });
      destroySession();
      finalizeExit(1);
    });
  }

  session.on("error", (error: Error) => {
    if (exited) return;
    const message = describeH2TransportError(error, baseUrl);
    appendDiagnostic(`[h2-session] client error: ${message}`);
    debugLog("bridge.session_error", { message });
    destroySession();
    finalizeExit(1);
  });

  session.on("goaway", (errorCode: number, _lastStreamId: number, opaqueData?: Buffer) => {
    if (exited) return;
    const opaque = opaqueData ? opaqueData.toString("utf8").slice(0, 200) : "";
    appendDiagnostic(`[h2-session] GOAWAY errorCode=${errorCode} opaque=${opaque}`);
    debugLog("bridge.goaway", { errorCode, opaque });
    // GOAWAY means the server closed the HTTP/2 connection gracefully. Signal the parent with a
    // retriable error frame so it can reconnect, then exit code 2 — the same contract
    // `classifyBridgeExit()` reads to decide whether transport loss is retryable.
    deliverData(
      connectEndStreamErrorFrame(
        "unavailable",
        `Cursor GOAWAY (errorCode=${errorCode}): upstream connection closed, retriable`,
      ),
    );
    destroySession();
    finalizeExit(2);
  });

  const pingEveryMs = PING_INTERVAL_MS;
  if (pingEveryMs > 0) {
    pingTimer = setInterval(() => {
      if (session.destroyed || session.closed) return;
      try {
        session.ping?.((err) => {
          if (err) debugLog("bridge.ping_failed", { message: err.message });
        });
      } catch (err) {
        debugLog("bridge.ping_threw", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }, pingEveryMs);
    pingTimer.unref?.();
  }

  armWatchdog(connectTimeoutMs);

  const openStream = (accessToken: string): void => {
    if (exited) return;
    if (session.destroyed || session.closed) {
      appendDiagnostic("[h2-session] cannot open stream: session closed");
      finalizeExit(1);
      return;
    }
    const stream = session.request(
      buildRequestHeaders(rpcPath, unary, accessToken),
    ) as unknown as H2Stream;
    attachStream(stream);
  };

  // Open the initial stream eagerly, same as h2-bridge.mjs did at process start.
  openStream(options.accessToken);

  const safeWrite = (data: Uint8Array): void => {
    if (exited || !currentStream || currentStream.closed || currentStream.destroyed) return;
    const buf = Buffer.from(data);
    if (currentStream.writableLength + buf.byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
      appendDiagnostic("[h2-session] write backpressure limit exceeded");
      destroySession();
      finalizeExit(1);
      return;
    }
    resetIdleWatchdog();
    try {
      currentStream.write(buf);
    } catch (err) {
      appendDiagnostic(
        `[h2-session] write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      destroySession();
      finalizeExit(1);
    }
  };

  const safeEnd = (): void => {
    if (exited) return;
    if (currentStream && !currentStream.closed && !currentStream.destroyed) {
      try {
        currentStream.end();
      } catch {
        // The stream may already be finishing.
      }
    }
    // Give the stream a short grace window to flush any trailing response bytes (mirrors
    // h2-bridge.mjs's own shutdown delay) before forcing the whole session closed.
    endGraceTimer = setTimeout(() => {
      destroySession();
      finalizeExit(0);
    }, END_GRACE_MS);
    endGraceTimer.unref?.();
  };

  return {
    proc: {
      kill: () => {
        destroySession();
        finalizeExit(1);
        return true;
      },
    },
    get alive() {
      return !exited;
    },
    lastStderr() {
      return stderrTail.trim();
    },
    write(data: Uint8Array) {
      safeWrite(data);
    },
    openStream(accessToken: string) {
      openStream(accessToken || options.accessToken);
    },
    end() {
      safeEnd();
    },
    onData(cb: (chunk: Buffer) => void) {
      cbs.data = cb;
      while (queuedData.length > 0 && !exited) {
        const payload = queuedData.shift()!;
        queuedDataBytes -= payload.byteLength;
        cbs.data(payload);
      }
    },
    onStreamDone(cb: () => void) {
      cbs.streamDone = cb;
      if (queuedStreamDone && !exited) {
        queuedStreamDone = false;
        try {
          cb();
        } catch (error) {
          debugLog("bridge.stream_done_callback_error", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    onClose(cb: (code: number) => void) {
      if (exited) {
        queueMicrotask(() => {
          try {
            cb(exitCode);
          } catch (error) {
            debugLog("bridge.close_callback_error", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } else {
        cbs.close = cb;
      }
    },
  };
}

export function createInProcessBridge(
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog,
): BridgeHandle {
  const baseUrl = options.url ?? CURSOR_API_URL;
  const session = http2.connect(baseUrl) as unknown as H2Session;
  return createBridgeHandleForSession(session, options, debugLog);
}

export const __testInternals = {
  createBridgeHandleForSession,
};
