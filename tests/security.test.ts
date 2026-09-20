import { describe, expect, it } from "vitest";

import { assertSafeCursorBaseUrl, redactSecrets } from "../src/utils/security.js";
import { sanitizeForDebug } from "../src/stream/debug-log.js";

describe("Cursor endpoint validation", () => {
  it("requires TLS for remote Cursor endpoints", () => {
    expect(() => assertSafeCursorBaseUrl("http://agent.cursor.sh")).toThrow(/HTTPS/);
    expect(assertSafeCursorBaseUrl("https://agent.cursor.sh///")).toBe("https://agent.cursor.sh");
  });

  it("allows plaintext only for loopback development servers", () => {
    expect(assertSafeCursorBaseUrl("http://localhost:8080/test/")).toBe(
      "http://localhost:8080/test",
    );
    expect(assertSafeCursorBaseUrl("http://[::1]:8080/test")).toBe("http://[::1]:8080/test");
  });

  it("rejects embedded credentials and unrelated hosts", () => {
    expect(() => assertSafeCursorBaseUrl("https://token@agent.cursor.sh")).toThrow(/credentials/);
    expect(() => assertSafeCursorBaseUrl("https://cursor.sh.example.test")).toThrow(/not allowed/);
  });
});

describe("secret redaction", () => {
  it("redacts JWTs and bearer tokens in error text", () => {
    const jwt = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "eyJzdWIiOiIxMjM0In0",
      "signaturepad",
    ].join(".");
    expect(redactSecrets(`Cursor token refresh failed: ${jwt}`)).toContain("[redacted-jwt]");
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toMatch(/\[redacted\]/);
  });

  it("redacts refresh tokens in debug payloads", () => {
    const sanitized = sanitizeForDebug({
      refreshToken: "secret-refresh",
      access: "secret-access",
      modelId: "composer-2",
    }) as Record<string, unknown>;
    expect(sanitized.refreshToken).toBe("<redacted>");
    expect(sanitized.access).toBe("<redacted>");
    expect(sanitized.modelId).toBe("composer-2");
  });
});
