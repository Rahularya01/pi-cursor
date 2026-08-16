import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  __testInternals,
  createConnectFrameParser,
  frameConnectMessage,
  lpEncode,
  MAX_CONNECT_MESSAGE_BYTES,
} from "../src/client/bridge.js";
import { decodeBase64Image } from "../src/stream/images.js";

describe("transport input bounds", () => {
  function childHarness() {
    const proc = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const events: string[] = [];
    const bridge = __testInternals.createBridgeHandleForChild(
      proc,
      { accessToken: "token", rpcPath: "/test" },
      (event) => events.push(event),
    );
    return { proc, bridge, events };
  }

  it("turns child-process spawn errors into a bridge close instead of an uncaught exception", async () => {
    const { proc, bridge, events } = childHarness();
    const closed = vi.fn();
    bridge.onClose(closed);
    const error = Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });

    expect(() => proc.emit("error", error)).not.toThrow();
    await Promise.resolve();

    expect(bridge.alive).toBe(false);
    expect(closed).toHaveBeenCalledWith(1);
    expect(bridge.lastStderr()).toContain("spawn EAGAIN");
    expect(events).toContain("bridge.process_error");
  });

  it("contains exceptions thrown by bridge data consumers", () => {
    const { proc, bridge, events } = childHarness();
    bridge.onData(() => {
      throw new Error("consumer failed");
    });

    expect(() => proc.stdout.write(lpEncode(new Uint8Array([1])))).not.toThrow();
    expect(proc.kill).toHaveBeenCalled();
    expect(bridge.alive).toBe(false);
    expect(events).toContain("bridge.data_callback_error");
  });

  it("buffers early bridge output until the consumer is registered", () => {
    const { proc, bridge } = childHarness();
    proc.stdout.write(lpEncode(new Uint8Array([7, 8, 9])));
    const received: number[][] = [];

    bridge.onData((data) => received.push(Array.from(data)));

    expect(received).toEqual([[7, 8, 9]]);
    expect(bridge.alive).toBe(true);
  });

  it("rejects oversized declared Connect frames before buffering their bodies", () => {
    const parser = createConnectFrameParser(
      () => {},
      () => {},
    );
    const header = Buffer.alloc(5);
    header.writeUInt32BE(MAX_CONNECT_MESSAGE_BYTES + 1, 1);
    expect(() => parser(header)).toThrow(/exceeds/);
  });

  it("attaches forensic diagnostics to a declared-length overflow for debugging a desync", () => {
    const parser = createConnectFrameParser(
      () => {},
      () => {},
    );
    // One clean frame first, so bytesConsumed/framesParsed reflect real prior progress.
    const clean = frameConnectMessage(new Uint8Array([1, 2, 3]));
    parser(clean);

    const header = Buffer.alloc(5);
    header.writeUInt32BE(MAX_CONNECT_MESSAGE_BYTES + 1, 1);
    const trailing = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    let caught: unknown;
    try {
      parser(Buffer.concat([header, trailing]));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const diagnostics = (caught as Error & { connectFrameDesync?: unknown }).connectFrameDesync;
    expect(diagnostics).toEqual({
      bytesConsumedBeforeDesync: clean.length,
      framesParsedBeforeDesync: 1,
      headerHex: header.toString("hex"),
      trailingContextHex: trailing.toString("hex"),
    });
  });

  it("rejects oversized inline images before base64 decoding", () => {
    const oversized = "A".repeat(Math.ceil((5_242_880 * 4) / 3) + 1025);
    expect(() =>
      decodeBase64Image(oversized, "image/png", { enforceCursorCliLimits: true }),
    ).toThrow(/encoded limit/);
  });

  it("reassembles Connect frames correctly regardless of how the byte stream is chunked", () => {
    // Regression test for the internal chunk-accumulator: frame reassembly must be independent of
    // how the underlying transport happens to fragment the byte stream, including the pathological
    // case of a large frame arriving split across many tiny reads.
    function randInt(max: number): number {
      return Math.floor(Math.random() * max);
    }

    for (let trial = 0; trial < 50; trial++) {
      const frameCount = 1 + randInt(6);
      const expected: Buffer[] = [];
      const wire: Buffer[] = [];
      for (let i = 0; i < frameCount; i++) {
        // Occasionally a large frame, mostly small — mirrors real traffic (text deltas vs.
        // checkpoints/tool results).
        const len = randInt(20) === 0 ? randInt(150_000) : randInt(2_000);
        const payload = Buffer.alloc(len);
        for (let j = 0; j < len; j += 97) payload[j] = randInt(256);
        expected.push(payload);
        const framed = Buffer.alloc(5 + len);
        framed.writeUInt32BE(len, 1);
        payload.copy(framed, 5);
        wire.push(framed);
      }
      const all = Buffer.concat(wire);

      const received: Buffer[] = [];
      const parser = createConnectFrameParser(
        (bytes) => received.push(Buffer.from(bytes)),
        (bytes) => received.push(Buffer.from(bytes)),
      );

      let offset = 0;
      while (offset < all.length) {
        // Heavily favor tiny chunks to stress the merge path that reassembles a frame spanning
        // many reads.
        const size = randInt(4) === 0 ? 1 + randInt(4_000) : 1 + randInt(8);
        const end = Math.min(offset + size, all.length);
        parser(all.subarray(offset, end));
        offset = end;
      }

      expect(received.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(received[i]!.equals(expected[i]!)).toBe(true);
      }
    }
  });
});
