import { describe, expect, it } from "bun:test";
import { resolveSystemCredentialPolicy, systemCredentialsAllowed } from "../src/auth/consent.js";

describe("system credential consent", () => {
  it("allows by default", () => {
    expect<string>(resolveSystemCredentialPolicy(undefined)).toBe("allow");
    expect(systemCredentialsAllowed(undefined)).toBe(true);
  });

  it("denies on explicit opt-out values", () => {
    for (const v of ["0", "false", "off", "deny", "no", "FALSE"]) {
      expect<string>(resolveSystemCredentialPolicy(v)).toBe("deny");
    }
  });

  it("allows on explicit opt-in values", () => {
    for (const v of ["1", "true", "on", "allow", "yes"]) {
      expect<string>(resolveSystemCredentialPolicy(v)).toBe("allow");
    }
  });

  it("fails closed on unknown values", () => {
    expect<string>(resolveSystemCredentialPolicy("maybe")).toBe("deny");
  });
});
