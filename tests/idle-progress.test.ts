import { afterEach, describe, expect, it } from "vitest";
import {
  __testInternals,
  canBlindIdleRestart,
  interactionUpdateCountsAsProgress,
  resolveH2ConnectTimeoutMs,
  resolveH2IdleTimeoutMs,
  resolveResumeIdleTimeoutMs,
  resolveStreamIdleMaxRetries,
  resolveStreamIdleTimeoutMs,
} from "../src/stream/native-core.js";

afterEach(() => {
  __testInternals.conversationStates.clear();
});

describe("idle progress classification", () => {
  it("treats tokenDelta and toolCallCompleted as watchdog progress", () => {
    expect(interactionUpdateCountsAsProgress("tokenDelta")).toBe(true);
    expect(interactionUpdateCountsAsProgress("toolCallCompleted")).toBe(true);
  });

  it("requires non-empty text for text/thinking deltas", () => {
    expect(interactionUpdateCountsAsProgress("textDelta", true)).toBe(true);
    expect(interactionUpdateCountsAsProgress("textDelta", false)).toBe(false);
    expect(interactionUpdateCountsAsProgress("thinkingDelta", true)).toBe(true);
    expect(interactionUpdateCountsAsProgress("thinkingDelta", false)).toBe(false);
  });

  it("blocks blind restarts once user-visible content was streamed", () => {
    expect(canBlindIdleRestart(false)).toBe(true);
    expect(canBlindIdleRestart(true)).toBe(false);
  });
});

describe("idle timeout resolvers", () => {
  it("defaults stream/resume idle and retries to disabled (0)", () => {
    expect(resolveStreamIdleTimeoutMs(undefined)).toBe(0);
    expect(resolveResumeIdleTimeoutMs(undefined)).toBe(0);
    expect(resolveStreamIdleMaxRetries(undefined)).toBe(0);
  });

  it("defaults h2 activity idle to disabled; connect timeout stays 30s", () => {
    expect(resolveH2ConnectTimeoutMs(undefined)).toBe(30_000);
    expect(resolveH2IdleTimeoutMs(undefined)).toBe(0);
  });

  it("parses env overrides and rejects invalid values", () => {
    expect(resolveStreamIdleTimeoutMs("120000")).toBe(120_000);
    expect(resolveStreamIdleTimeoutMs("0")).toBe(0);
    expect(resolveStreamIdleTimeoutMs("nope")).toBe(0);
    expect(resolveStreamIdleMaxRetries("0")).toBe(0);
    expect(resolveStreamIdleMaxRetries("99")).toBe(10);
    expect(resolveH2IdleTimeoutMs("60000")).toBe(60_000);
    expect(resolveH2IdleTimeoutMs("0")).toBe(0);
  });
});

describe("disabled idle watchdog", () => {
  it("never fires when timeoutMs is 0", async () => {
    let fired = 0;
    const watchdog = __testInternals.createStreamIdleWatchdog({
      timeoutMs: 0,
      onTimeout: () => {
        fired += 1;
      },
    });
    watchdog.start();
    watchdog.reset();
    await new Promise((resolve) => setTimeout(resolve, 40));
    watchdog.clear();
    expect(fired).toBe(0);
  });
});

describe("stream idle watchdog", () => {
  it("fires after the configured timeout when never reset", async () => {
    let fired = 0;
    const watchdog = __testInternals.createStreamIdleWatchdog({
      timeoutMs: 30,
      onTimeout: () => {
        fired += 1;
      },
    });
    watchdog.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    watchdog.clear();
    expect(fired).toBe(1);
  });

  it("does not fire while progress keeps resetting it", async () => {
    let fired = 0;
    const watchdog = __testInternals.createStreamIdleWatchdog({
      timeoutMs: 50,
      onTimeout: () => {
        fired += 1;
      },
    });
    watchdog.start();
    const interval = setInterval(() => watchdog.reset(), 15);
    await new Promise((resolve) => setTimeout(resolve, 120));
    clearInterval(interval);
    watchdog.clear();
    expect(fired).toBe(0);
  });
});

describe("blob store trim", () => {
  it("drops oldest blobs when the soft cap is exceeded", () => {
    const store = new Map<string, Uint8Array>();
    store.set("old", new Uint8Array(100));
    store.set("mid", new Uint8Array(100));
    store.set("new", new Uint8Array(50));
    const result = __testInternals.trimBlobStore(store, 120);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.totalBytes).toBeLessThanOrEqual(120);
    expect(store.has("new")).toBe(true);
  });
});
