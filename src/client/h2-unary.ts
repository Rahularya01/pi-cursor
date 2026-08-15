/**
 * In-process HTTP/2 transport for Cursor's unary Connect RPCs.
 *
 * Streaming still goes through the h2-bridge child process — Bun's node:http2
 * is broken for the bidirectional case, which is why that bridge exists. Unary
 * calls have no such constraint on Node, and paying a process spawn plus a
 * fresh TLS/H2 handshake (and the bridge's 100ms stdout flush before exit) for
 * a single request/response round-trip cost roughly 1.5s across the two model
 * discovery calls.
 *
 * `fetch` is not an option: both api2.cursor.sh and the agent hosts speak HTTP/2
 * only, and undici rejects the h2 preface with an HTTPParserError.
 */
import http2 from "node:http2";
import { randomUUID } from "node:crypto";

import { getCursorClientVersion } from "../config/index.js";

const CURSOR_API_URL = "https://api2.cursor.sh";
export const MAX_UNARY_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface UnaryH2Options {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface UnaryH2Result {
  status: number;
  body: Buffer;
}

/** True when node:http2 client sessions are usable in this runtime. */
export function supportsInProcessH2(): boolean {
  if (process.env.PI_CURSOR_UNARY_BRIDGE === "1") return false;
  // Bun's node:http2 client cannot carry these requests reliably.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return false;
  return typeof http2?.connect === "function";
}

/**
 * Perform one unary Connect RPC over an in-process HTTP/2 session.
 *
 * Rejects on transport failure so callers can fall back to the child-process
 * bridge; a non-2xx response resolves normally with the status for the caller
 * to interpret.
 */
export function callUnaryOverH2(options: UnaryH2Options): Promise<UnaryH2Result> {
  const origin = options.url ?? CURSOR_API_URL;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise<UnaryH2Result>((resolve, reject) => {
    let settled = false;
    let session: http2.ClientHttp2Session | undefined;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        session?.close();
      } catch {
        // Session may already be torn down by the error that brought us here.
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        session?.destroy();
      } catch {
        // Destroy is best effort; the session is being abandoned either way.
      }
      reject(err);
    };

    const succeed = (result: UnaryH2Result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    function onAbort() {
      fail(new Error("Cursor unary RPC aborted"));
    }

    if (options.signal?.aborted) {
      reject(new Error("Cursor unary RPC aborted"));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new Error(`Cursor unary RPC timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    }

    try {
      session = http2.connect(origin);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    session.on("error", (err) => fail(err));

    const request = session.request({
      ":method": "POST",
      ":path": options.rpcPath,
      // Unary uses raw protobuf, matching the h2-bridge's `unary: true` mode.
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      te: "trailers",
      authorization: `Bearer ${options.accessToken}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": getCursorClientVersion(),
      "x-cursor-client-type": "cli",
      "x-request-id": randomUUID(),
    });

    const chunks: Buffer[] = [];
    let responseBytes = 0;
    let status = 0;

    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    request.on("data", (chunk: Buffer) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_UNARY_RESPONSE_BYTES) {
        request.close(http2.constants.NGHTTP2_CANCEL);
        fail(new Error(`Cursor unary response exceeds ${MAX_UNARY_RESPONSE_BYTES} bytes`));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("error", (err) => fail(err));
    request.on("end", () => succeed({ status, body: Buffer.concat(chunks) }));

    request.end(Buffer.from(options.requestBody));
  });
}
