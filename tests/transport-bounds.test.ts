import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  __testInternals,
  createConnectFrameParser,
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

  it("rejects oversized inline images before base64 decoding", () => {
    const oversized = "A".repeat(Math.ceil((5_242_880 * 4) / 3) + 1025);
    expect(() =>
      decodeBase64Image(oversized, "image/png", { enforceCursorCliLimits: true }),
    ).toThrow(/encoded limit/);
  });
});
