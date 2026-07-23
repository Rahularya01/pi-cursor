import { describe, expect, it } from "vitest";
import { resolveSystemCredentialPolicy, systemCredentialsAllowed } from "../src/auth/consent.js";

describe("system credential consent", () => {
  it("allows by default", () => {
    expect(resolveSystemCredentialPolicy(undefined)).toBe("allow");
    expect(systemCredentialsAllowed(undefined)).toBe(true);
  });

  it("denies on explicit opt-out values", () => {
    for (const v of ["0", "false", "off", "deny", "no", "FALSE"]) {
      expect(resolveSystemCredentialPolicy(v)).toBe("deny");
    }
  });

  it("allows on explicit opt-in values", () => {
    for (const v of ["1", "true", "on", "allow", "yes"]) {
      expect(resolveSystemCredentialPolicy(v)).toBe("allow");
    }
  });

  it("fails closed on unknown values", () => {
    expect(resolveSystemCredentialPolicy("maybe")).toBe("deny");
  });
});
