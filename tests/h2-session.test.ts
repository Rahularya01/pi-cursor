import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "bun:test";

import {
  createConnectFrameParser,
  MAX_BRIDGE_MESSAGE_BYTES,
  parseConnectEndStream,
} from "../src/client/bridge.js";
import {
  __testInternals,
  describeH2TransportError,
  type H2Session,
  type H2Stream,
} from "../src/client/h2-session.js";

function fakeStream(): H2Stream & { emit: EventEmitter["emit"] } {
  const emitter = new EventEmitter();
  const stream = Object.assign(emitter, {
    destroyed: false,
    closed: false,
    writableLength: 0,
    write: vi.fn(() => true),
    end: vi.fn(() => {
      stream.closed = true;
    }),
    destroy: vi.fn(() => {
      stream.destroyed = true;
    }),
    close: vi.fn(() => {
      stream.closed = true;
    }),
  });
  return stream as unknown as H2Stream & { emit: EventEmitter["emit"] };
}

function sessionHarness(options: { persistent?: boolean; unary?: boolean } = {}) {
  const requestHeaders: Record<string, unknown>[] = [];
  const streams: ReturnType<typeof fakeStream>[] = [];
  const emitter = new EventEmitter();
  const session = Object.assign(emitter, {
    destroyed: false,
    closed: false,
    close: vi.fn(() => {
      session.closed = true;
    }),
    destroy: vi.fn(() => {
      session.destroyed = true;
    }),
    request: vi.fn((headers: Record<string, unknown>) => {
      requestHeaders.push(headers);
      const s = fakeStream();
      streams.push(s);
      return s;
    }),
  });

  const events: string[] = [];
  const bridge = __testInternals.createBridgeHandleForSession(
    session as unknown as H2Session,
    { accessToken: "token-1", rpcPath: "/agent.v1.AgentService/Run", ...options },
    (event) => events.push(event),
  );
  return { session, streams, requestHeaders, bridge, events };
}

/** Decode the single end-stream Connect frame delivered to `onData`. */
function decodeEndStreamFrame(frame: Buffer): Error | null {
  let result: Error | null = null;
  const parser = createConnectFrameParser(
    () => {},
    (bytes) => {
      result = parseConnectEndStream(bytes);
    },
  );
  parser(frame);
  return result;
}

describe("describeH2TransportError", () => {
  it("explains an ALPN-stripped HTTP/2 handshake", () => {
    const raw = Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
    const message = describeH2TransportError(raw, "https://api2.cursor.sh");
    expect(message).toContain("https://api2.cursor.sh");
    expect(message).toContain("ALPN");
  });

  it("passes through unrelated HTTP/2 errors untouched", () => {
    const raw = Object.assign(new Error("stream closed"), { code: "ERR_HTTP2_STREAM_ERROR" });
    expect(describeH2TransportError(raw, "https://api2.cursor.sh")).toBe("stream closed");
  });
});

describe("in-process h2 session bridge", () => {
  it("opens the Connect stream with the expected request headers", () => {
    const { requestHeaders } = sessionHarness();
    const headers = requestHeaders[0]!;
    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe("/agent.v1.AgentService/Run");
    expect(headers["content-type"]).toBe("application/connect+proto");
    expect(headers.authorization).toBe("Bearer token-1");
  });

  it("delivers a retriable end-stream frame and closes with exit code 2 on GOAWAY", () => {
    const { session, streams, bridge } = sessionHarness({ persistent: true });
    const frames: Buffer[] = [];
    bridge.onData((chunk) => frames.push(chunk));
    const closed = vi.fn();
    bridge.onClose(closed);

    session.emit("goaway", 0, 1, Buffer.from("bye"));

    expect(frames).toHaveLength(1);
    const endError = decodeEndStreamFrame(frames[0]!);
    expect(endError?.message).toContain("unavailable");
    expect(endError?.message).toContain("retriable");
    expect(closed).toHaveBeenCalledWith(2);
    expect(streams[0]!.destroy).not.toHaveBeenCalled(); // torn down via session.destroy, not the stream
    expect(session.destroy).toHaveBeenCalled();
  });

  it("delivers an http_<status> end-stream frame and closes with exit code 1 on a non-2xx response", () => {
    const { streams, bridge } = sessionHarness();
    const frames: Buffer[] = [];
    bridge.onData((chunk) => frames.push(chunk));
    const closed = vi.fn();
    bridge.onClose(closed);

    streams[0]!.emit("response", { ":status": 503 });
    streams[0]!.emit("data", Buffer.from("upstream unavailable"));
    streams[0]!.emit("end");

    expect(frames).toHaveLength(1);
    const endError = decodeEndStreamFrame(frames[0]!);
    expect(endError?.message).toContain("http_503");
    expect(closed).toHaveBeenCalledWith(1);
  });

  it("reuses the session for the next turn via openStream", () => {
    const { session, streams, requestHeaders, bridge } = sessionHarness({ persistent: true });
    const done = vi.fn();
    bridge.onStreamDone!(done);

    streams[0]!.emit("end");
    expect(done).toHaveBeenCalledTimes(1);
    expect(bridge.alive).toBe(true);

    bridge.openStream!("token-2");

    expect(session.request).toHaveBeenCalledTimes(2);
    expect(requestHeaders[1]!.authorization).toBe("Bearer token-2");
    expect(streams).toHaveLength(2);
  });

  it("enforces the write backpressure cap", () => {
    const { session, streams, bridge } = sessionHarness();
    (streams[0] as unknown as { writableLength: number }).writableLength = MAX_BRIDGE_MESSAGE_BYTES;

    bridge.write(new Uint8Array([1, 2, 3]));

    expect(bridge.alive).toBe(false);
    expect(session.destroy).toHaveBeenCalled();
  });
});
