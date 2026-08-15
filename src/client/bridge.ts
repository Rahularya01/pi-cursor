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
  /** Initial connect idle kill (ms). Default 30s. */
  connectTimeoutMs?: number;
  /** Activity idle kill after first I/O (ms). Default 15m. */
  idleTimeoutMs?: number;
}

export interface BridgeHandle {
  proc: Pick<ChildProcess, "kill">;
  readonly alive: boolean;
  /** Trailing stderr from the child process (for diagnostics / recovery). */
  lastStderr(): string;
  write(data: Uint8Array): void;
  end(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: (code: number) => void): void;
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
  };
  const queuedData: Buffer[] = [];
  let queuedDataBytes = 0;

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
    connectTimeoutMs: options.connectTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
  });
  safeWrite(new TextEncoder().encode(config));

  let pending = Buffer.alloc(0);
  stdout?.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const len = pending.readUInt32BE(0);
      if (len > MAX_BRIDGE_MESSAGE_BYTES) {
        pending = Buffer.alloc(0);
        proc.kill();
        return;
      }
      if (pending.length < 4 + len) break;
      const payload = pending.subarray(4, 4 + len);
      pending = pending.subarray(4 + len);
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

export function createConnectFrameParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (incoming: Buffer) => {
    pending = Buffer.concat([pending, incoming]);
    while (pending.length >= 5) {
      const flags = pending[0]!;
      const msgLen = pending.readUInt32BE(1);
      if (msgLen > MAX_CONNECT_MESSAGE_BYTES) {
        pending = Buffer.alloc(0);
        throw new Error(
          `Connect message exceeds ${MAX_CONNECT_MESSAGE_BYTES} bytes (incoming, declared length ${msgLen}). ` +
            `Enable PI_CURSOR_PROVIDER_DEBUG=1 and check the lifecycle log for the frame preceding this error.`,
        );
      }
      if (pending.length < 5 + msgLen) break;
      const messageBytes = pending.subarray(5, 5 + msgLen);
      pending = pending.subarray(5 + msgLen);
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
