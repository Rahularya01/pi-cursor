import { describe, expect, it, vi } from "vitest";

import { createCursorAuthClient } from "../src/auth/oauth.js";

describe("Cursor OAuth transport", () => {
  it("honors cancellation before polling starts", async () => {
    const fetchMock = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const client = createCursorAuthClient({
      fetch: fetchMock as typeof fetch,
      sleep: async () => {},
    });

    await expect(client.poll("uuid", "verifier", { signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("interrupts the polling backoff when cancelled", async () => {
    const fetchMock = vi.fn();
    const controller = new AbortController();
    const client = createCursorAuthClient({
      fetch: fetchMock as typeof fetch,
      sleep: () => new Promise<void>(() => {}),
    });

    const polling = client.poll("uuid", "verifier", { signal: controller.signal });
    controller.abort();

    await expect(polling).rejects.toThrow(/aborted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("times out a hung refresh request", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
            once: true,
          });
        }),
    );
    const client = createCursorAuthClient({
      fetch: fetchMock as typeof fetch,
      requestTimeoutMs: 1,
    });

    await expect(client.refreshToken("refresh-token")).rejects.toThrow(/aborted/);
  });

  it("rejects successful responses without an access token", async () => {
    const client = createCursorAuthClient({
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ refreshToken: "refresh" })),
      ) as unknown as typeof fetch,
    });
    await expect(client.refreshToken("refresh-token")).rejects.toThrow(/no access token/);
  });

  it("redacts refresh error bodies", async () => {
    const jwt = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiIxMjM0In0",
      "signaturepad",
    ].join(".");
    const client = createCursorAuthClient({
      fetch: vi.fn(async () => new Response(jwt, { status: 401 })) as unknown as typeof fetch,
    });
    await expect(client.refreshToken("refresh-token")).rejects.toThrow(/\[redacted-jwt\]/);
  });
});
