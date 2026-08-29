import { ConnectFlag } from "../types/enums.js";
import { createInProcessBridge } from "./h2-session.js";

const CONNECT_END_STREAM_FLAG = ConnectFlag.EndStream;
export const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_CONNECT_MESSAGE_BYTES = 64 * 1024 * 1024;

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

/** Minimal shape a `BridgeHandle` needs for forceful teardown — no longer literally a child
 *  process now that the transport runs in-process, but kept `.kill()`-shaped since every call
 *  site only ever calls it and never inspects anything else. */
export interface BridgeProcessHandle {
  kill(): boolean;
}

export interface BridgeHandle {
  proc: BridgeProcessHandle;
  readonly alive: boolean;
  /** Trailing transport diagnostics (HTTP/2 errors, GOAWAY, non-2xx bodies). */
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
  /** Fires when a persistent bridge reports the current stream ended. */
  onStreamDone?(cb: () => void): void;
}

export type BridgeFactory = (options: SpawnBridgeOptions) => BridgeHandle;
export type BridgeDebugLog = (event: string, data?: Record<string, unknown>) => void;

function noopDebugLog(): void {}

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

/**
 * Opens a `BridgeHandle` for one Cursor Connect RPC (streaming or unary), backed directly by an
 * in-process HTTP/2 session — see `h2-session.ts` for the transport implementation and why no
 * subprocess is needed.
 */
export function spawnBridge(
  options: SpawnBridgeOptions,
  debugLog: BridgeDebugLog = noopDebugLog,
): BridgeHandle {
  debugLog("bridge.spawn", {
    rpcPath: options.rpcPath,
    url: options.url,
    unary: options.unary ?? false,
  });
  return createInProcessBridge(options, debugLog);
}

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
