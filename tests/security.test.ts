import { describe, expect, it } from "vitest";

import { assertSafeCursorBaseUrl } from "../src/utils/security.js";

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
