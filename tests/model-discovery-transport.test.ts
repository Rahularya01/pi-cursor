import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeHandle } from "../src/client/bridge.js";
import { setBridgeFactoryForTests } from "../src/stream/bridge-session.js";
import { callCursorUnaryRpc } from "../src/stream/model-discovery.js";

describe("model discovery child-process transport", () => {
  afterEach(() => {
    setBridgeFactoryForTests();
    delete process.env.PI_CURSOR_UNARY_BRIDGE;
    vi.useRealTimers();
  });

  function bridgeHarness(options?: { throwOnWrite?: boolean }) {
    let onData: (data: Buffer) => void = () => {};
    let onClose: (exitCode: number) => void = () => {};
    const writes: Uint8Array[] = [];
    const kill = vi.fn(() => true);
    const bridge: BridgeHandle = {
      proc: { kill } as BridgeHandle["proc"],
      alive: true,
      lastStderr: () => "",
      write(data) {
        if (options?.throwOnWrite) throw new Error("write failed");
        writes.push(data);
      },
      end() {},
      onData(callback) {
        onData = callback;
      },
      onClose(callback) {
        onClose = callback;
      },
    };
    return {
      bridge,
      writes,
      kill,
      emitData: (data: Uint8Array) => onData(Buffer.from(data)),
      close: (exitCode = 0) => onClose(exitCode),
    };
  }

  it("collects the bounded response and closes successfully", async () => {
    process.env.PI_CURSOR_UNARY_BRIDGE = "1";
    const harness = bridgeHarness();
    setBridgeFactoryForTests(() => harness.bridge);

    const pending = callCursorUnaryRpc({
      accessToken: "token",
      rpcPath: "/models",
      requestBody: new Uint8Array([1, 2]),
      timeoutMs: 0,
    });
    harness.emitData(new Uint8Array([3, 4]));
    harness.close();

    const result = await pending;
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Array.from(result.body)).toEqual([3, 4]);
    expect(harness.writes).toEqual([new Uint8Array([1, 2])]);
  });

  it("kills the bridge when the request is already aborted", async () => {
    process.env.PI_CURSOR_UNARY_BRIDGE = "1";
    const harness = bridgeHarness();
    setBridgeFactoryForTests(() => harness.bridge);
    const controller = new AbortController();
    controller.abort();

    await expect(
      callCursorUnaryRpc({
        accessToken: "token",
        rpcPath: "/models",
        requestBody: new Uint8Array(),
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ exitCode: 1, timedOut: true });
    expect(harness.kill).toHaveBeenCalledOnce();
    expect(harness.writes).toHaveLength(0);
  });

  it("cleans up a bridge whose stdin write fails", async () => {
    process.env.PI_CURSOR_UNARY_BRIDGE = "1";
    const harness = bridgeHarness({ throwOnWrite: true });
    setBridgeFactoryForTests(() => harness.bridge);

    await expect(
      callCursorUnaryRpc({
        accessToken: "token",
        rpcPath: "/models",
        requestBody: new Uint8Array([1]),
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({ exitCode: 1, timedOut: false });
    expect(harness.kill).toHaveBeenCalledOnce();
  });
});
