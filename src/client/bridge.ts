import { spawn, type ChildProcess } from "node:child_process";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ConnectFlag } from "../types/enums.js";

const CURSOR_API_URL = "https://api2.cursor.sh";
const CONNECT_END_STREAM_FLAG = ConnectFlag.EndStream;
export const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_CONNECT_MESSAGE_BYTES = 64 * 1024 * 1024;
const BRIDGE_PATH = pathResolve(dirname(fileURLToPath(import.meta.url)), "h2-bridge.mjs");

export interface SpawnBridgeOptions {
  accessToken: string;
  rpcPath: string;
  url?: string;
  unary?: boolean;
  /**
   * Keep the HTTP/2 session alive after a stream ends so the next turn can
   * open a new stream without a process spawn + TLS handshake. Streaming
   * chat uses this; unary RPCs do not.
   */
  persistent?: boolean;
  /** Initial connect idle kill (ms). Default 30s. */
  connectTimeoutMs?: number;
  /** Activity idle kill after first I/O (ms). Default 15m. */
  idleTimeoutMs?: number;
}

/** Sentinel the persistent h2-bridge writes when a Connect stream ends but the process stays up. */
export const STREAM_DONE_MAGIC = Buffer.from("PI_CURSOR_STREAM_DONE");

export interface BridgeHandle {
  proc: Pick<ChildProcess, "kill">;
  readonly alive: boolean;
  /** Trailing stderr from the child process (for diagnostics / recovery). */
  lastStderr(): string;
  write(data: Uint8Array): void;
  end(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: (code: number) => void): void;
  /**
   * Open a new Connect stream on a persistent bridge. Absent on one-shot
   * (unary / test) handles.
   */
  openStream?(accessToken: string): void;
  /** Fires when a persistent child reports the current stream ended. */
  onStreamDone?(cb: () => void): void;
}

export type BridgeFactory = (options: SpawnBridgeOptions) => BridgeHandle;
export type BridgeDebugLog = (event: string, data?: Record<string, unknown>) => void;

function noopDebugLog(): void {}

type BridgeChildProcess = Pick<ChildProcess, "kill"> & {
  on(event: string | symbol, listener: (...args: any[]) => void): unknown;
  stdin?: NodeJS.WritableStream | null;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
};

export function lpEncode(data: Uint8Array): Buffer {
  if (data.byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
    throw new Error(`Bridge message exceeds ${MAX_BRIDGE_MESSAGE_BYTES} bytes`);
  }
  const buf = Buffer.alloc(4 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.set(data, 4);
  return buf;
}

/**
 * Accumulates incoming chunks for length-prefixed frame parsing without re-concatenating the
 * whole backlog on every chunk. Naively doing `pending = Buffer.concat([pending, chunk])` on
 * every `data` event is O(n^2) in the frame's total size when a single large frame arrives
 * split across many small reads — each partial chunk re-copies everything buffered so far.
 * Buffering chunks in an array and only concatenating once a full frame is available keeps
 * total work O(n).
 */
class FrameAccumulator {
  private chunks: Buffer[] = [];
  private totalLength = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
  }

  get length(): number {
    return this.totalLength;
  }

  reset(): void {
    this.chunks = [];
    this.totalLength = 0;
  }

  /**
   * Merge only as many leading chunks as needed to cover the first `n` bytes (all `n` bytes
   * must already be buffered), then fold that merge back into `chunks[0]` so a later call for
   * the same or a smaller `n` is O(1) instead of re-merging. Chunks after the ones needed for
   * `n` are left untouched — critical while still waiting on the rest of a large in-progress
   * frame, so a header peek doesn't re-copy the whole backlog on every incoming chunk.
   */
  private frontBytes(n: number): Buffer {
    const first = this.chunks[0];
    if (!first || first.length >= n) return (first ?? Buffer.alloc(0)).subarray(0, n);
    let covered = 0;
    let count = 0;
    while (covered < n && count < this.chunks.length) {
      covered += this.chunks[count]!.length;
      count += 1;
    }
    const merged = Buffer.concat(this.chunks.slice(0, count), covered);
    this.chunks.splice(0, count, merged);
    return merged.subarray(0, n);
  }

  /** Read `n` bytes from the front without consuming them (all `n` bytes must already be buffered). */
  peek(n: number): Buffer {
    return this.frontBytes(n);
  }

  /** Consume and return the first `n` bytes (all `n` bytes must already be buffered). */
  consume(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const result = this.frontBytes(n);
    const first = this.chunks[0]!;
    if (first.length === n) this.chunks.shift();
    else this.chunks[0] = first.subarray(n);
    this.totalLength -= n;
    return result;
  }
}

export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  if (data.byteLength > MAX_CONNECT_MESSAGE_BYTES) {
    throw new Error(
      `Connect message exceeds ${MAX_CONNECT_MESSAGE_BYTES} bytes (outgoing, ${data.byteLength} bytes). ` +
        `Run /cursor.doctor and check lastRequestSize — this conversation's checkpoint or blob store has likely ` +
        `grown too large; starting a new session usually clears it.`,
    );
  }
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

export function spawnBridge(
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog = noopDebugLog,
): BridgeHandle {
  debugLog("bridge.spawn", {
    rpcPath: options.rpcPath,
    url: options.url ?? CURSOR_API_URL,
    unary: options.unary ?? false,
    cursorClientVersion: process.env.PI_CURSOR_CLIENT_VERSION || "cli-2026.05.01-eea359f",
  });
  const proc = spawn(process.execPath, [BRIDGE_PATH], {
    // Capture stderr so bridge deaths (HTTP/2 errors, panics) are diagnosable.
    stdio: ["pipe", "pipe", "pipe"],
  });

  return createBridgeHandleForChild(proc, options, debugLog);
}

function createBridgeHandleForChild(
  proc: BridgeChildProcess,
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog = noopDebugLog,
): BridgeHandle {
  const stdin = proc.stdin;
  const stdout = proc.stdout;
  const stderr = proc.stderr;

  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    close: null as ((code: number) => void) | null,
    streamDone: null as (() => void) | null,
  };
  const queuedData: Buffer[] = [];
  let queuedDataBytes = 0;
  let queuedStreamDone = false;

  let stderrBuf = "";
  let stderrTail = "";
  stderr?.on?.("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrTail = `${stderrTail}${text}`.slice(-8_000);
    stderrBuf += text;
    if (stderrBuf.length > 8_000) stderrBuf = stderrBuf.slice(-8_000);
    const lines = stderrBuf.split("\n");
    // Keep incomplete trailing line in the buffer.
    stderrBuf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) debugLog("bridge.stderr", { line: trimmed.slice(0, 500) });
    }
  });

  let exited = false;
  let exitCode = 1;
  let stdinClosed = !stdin;
  const markStdinClosed = (err?: unknown): void => {
    stdinClosed = true;
    if (err) {
      debugLog("bridge.stdin_error", {
        code:
          typeof err === "object" && err !== null && "code" in err
            ? String((err as { code?: unknown }).code)
            : undefined,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
  stdin?.on?.("error", markStdinClosed);
  stdin?.on?.("close", () => markStdinClosed());
  stdin?.on?.("finish", () => markStdinClosed());

  const invokeClose = (): void => {
    try {
      cbs.close?.(exitCode);
    } catch (error) {
      debugLog("bridge.close_callback_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const finalizeExit = (code: number): void => {
    if (exited) return;
    exited = true;
    exitCode = code;
    invokeClose();
  };
  const deliverData = (payload: Buffer): boolean => {
    if (payload.equals(STREAM_DONE_MAGIC)) {
      if (!cbs.streamDone) {
        queuedStreamDone = true;
        return true;
      }
      try {
        cbs.streamDone();
        return true;
      } catch (error) {
        debugLog("bridge.stream_done_callback_error", {
          message: error instanceof Error ? error.message : String(error),
        });
        try {
          proc.kill();
        } catch {
          // The process may already have exited.
        }
        finalizeExit(1);
        return false;
      }
    }
    if (!cbs.data) {
      queuedDataBytes += payload.byteLength;
      if (queuedDataBytes > MAX_BRIDGE_MESSAGE_BYTES) {
        debugLog("bridge.prelistener_buffer_limit", { queuedDataBytes });
        try {
          proc.kill();
        } catch {
          // The process may already have exited.
        }
        finalizeExit(1);
        return false;
      }
      queuedData.push(payload);
      return true;
    }
    try {
      cbs.data(payload);
      return true;
    } catch (error) {
      debugLog("bridge.data_callback_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        proc.kill();
      } catch {
        // The process may already have exited.
      }
      finalizeExit(1);
      return false;
    }
  };

  proc.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    stderrTail = `${stderrTail}\n[bridge process error] ${message}`.slice(-8_000);
    markStdinClosed(error);
    debugLog("bridge.process_error", {
      code:
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined,
      message,
    });
    finalizeExit(1);
  });
  stdout?.on?.("error", (error) => {
    debugLog("bridge.stdout_error", {
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      proc.kill();
    } catch {
      // The process may already have exited.
    }
    finalizeExit(1);
  });
  stderr?.on?.("error", (error) => {
    debugLog("bridge.stderr_error", {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  const safeWrite = (data: Uint8Array): void => {
    if (!stdin || stdinClosed) return;
    try {
      const framed = lpEncode(data);
      const queuedBytes = (stdin as NodeJS.WritableStream & { writableLength?: number })
        .writableLength;
      if ((queuedBytes ?? 0) + framed.byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
        markStdinClosed(new Error("Bridge stdin backpressure limit exceeded"));
        proc.kill();
        return;
      }
      stdin.write(framed);
    } catch (err) {
      markStdinClosed(err);
    }
  };

  const safeEnd = (): void => {
    if (!stdin || stdinClosed) return;
    try {
      stdin.end();
      stdinClosed = true;
    } catch (err) {
      markStdinClosed(err);
    }
  };

  const config = JSON.stringify({
    accessToken: options.accessToken,
    url: options.url ?? CURSOR_API_URL,
    path: options.rpcPath,
    unary: options.unary ?? false,
    persistent: options.persistent === true,
    connectTimeoutMs: options.connectTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
  });
  safeWrite(new TextEncoder().encode(config));

  const pending = new FrameAccumulator();
  stdout?.on("data", (chunk: Buffer) => {
    pending.push(chunk);
    while (pending.length >= 4) {
      const len = pending.peek(4).readUInt32BE(0);
      if (len > MAX_BRIDGE_MESSAGE_BYTES) {
        pending.reset();
        proc.kill();
        return;
      }
      if (pending.length < 4 + len) break;
      pending.consume(4);
      const payload = pending.consume(len);
      if (!deliverData(Buffer.from(payload))) return;
    }
  });

  proc.on("exit", (code) => {
    const resolvedCode = code ?? 1;
    debugLog("bridge.exit", { rpcPath: options.rpcPath, exitCode: resolvedCode });
    finalizeExit(resolvedCode);
  });

  return {
    proc,
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
      safeWrite(
        new TextEncoder().encode(
          JSON.stringify({ cmd: "open", accessToken: accessToken || options.accessToken }),
        ),
      );
    },
    end() {
      safeWrite(new Uint8Array(0));
      safeEnd();
    },
    onData(cb: (chunk: Buffer) => void) {
      cbs.data = cb;
      while (queuedData.length > 0 && !exited) {
        const payload = queuedData.shift()!;
        queuedDataBytes -= payload.byteLength;
        if (!deliverData(payload)) break;
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

export const __testInternals = {
  createBridgeHandleForChild,
};

/** Attached to the error thrown for a declared-length overflow so callers can log forensics
 *  (behind PI_CURSOR_PROVIDER_DEBUG) without needing to re-derive parser-internal state. */
export interface ConnectFrameDesyncDiagnostics {
  /** Bytes successfully parsed into complete frames before the desync, across this parser's life. */
  bytesConsumedBeforeDesync: number;
  /** Number of complete frames successfully parsed before the desync. */
  framesParsedBeforeDesync: number;
  /** Hex of the 5-byte header read as the (bogus) next frame. */
  headerHex: string;
  /** Hex of up to 32 bytes immediately following the header, for context. */
  trailingContextHex: string;
}

export function createConnectFrameParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
  const pending = new FrameAccumulator();
  let bytesConsumed = 0;
  let framesParsed = 0;
  return (incoming: Buffer) => {
    pending.push(incoming);
    while (pending.length >= 5) {
      const header = pending.peek(5);
      const flags = header[0]!;
      const msgLen = header.readUInt32BE(1);
      if (msgLen > MAX_CONNECT_MESSAGE_BYTES) {
        const contextLen = Math.min(32, pending.length - 5);
        const trailingContextHex =
          contextLen > 0
            ? pending
                .peek(5 + contextLen)
                .subarray(5)
                .toString("hex")
            : "";
        const diagnostics: ConnectFrameDesyncDiagnostics = {
          bytesConsumedBeforeDesync: bytesConsumed,
          framesParsedBeforeDesync: framesParsed,
          headerHex: header.toString("hex"),
          trailingContextHex,
        };
        pending.reset();
        throw Object.assign(
          new Error(
            `Connect message exceeds ${MAX_CONNECT_MESSAGE_BYTES} bytes (incoming, declared length ${msgLen}). ` +
              `Enable PI_CURSOR_PROVIDER_DEBUG=1 and check the lifecycle log for the frame preceding this error.`,
          ),
          { connectFrameDesync: diagnostics },
        );
      }
      if (pending.length < 5 + msgLen) break;
      pending.consume(5);
      const messageBytes = pending.consume(msgLen);
      bytesConsumed += 5 + msgLen;
      framesParsed += 1;
      if (flags & CONNECT_END_STREAM_FLAG) onEndStream(messageBytes);
      else onMessage(messageBytes);
    }
  };
}

export function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error)
      return new Error(
        `Connect error ${error.code ?? "unknown"}: ${error.message ?? "Unknown error"}`,
      );
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}
