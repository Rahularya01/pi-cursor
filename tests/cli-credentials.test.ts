import { describe, expect, it } from "vitest";

import { windowsUsernameFromEnv } from "../src/auth/cli-credentials.js";

describe("WSL Windows username", () => {
  it("reads the account from USERPROFILE and ignores sibling folders", () => {
    expect(
      windowsUsernameFromEnv({
        USERPROFILE: "C:\\Users\\rahul",
        USERNAME: "rahul",
      }),
    ).toBe("rahul");
    expect(
      windowsUsernameFromEnv({
        USERPROFILE: "/mnt/c/Users/rahul",
        USERNAME: "someone-else",
      }),
    ).toBe("rahul");
  });

  it("skips Public/Default profiles", () => {
    expect(windowsUsernameFromEnv({ USERPROFILE: "C:\\Users\\Public" })).toBeUndefined();
    expect(windowsUsernameFromEnv({ USERNAME: "Default" })).toBeUndefined();
  });
});
