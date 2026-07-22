import assert from "node:assert/strict";
import {
  getCursorKeychainToken,
  getCursorVscdbToken,
  resolveSystemCursorAccessToken,
} from "../src/auth/cli-credentials.js";

async function runTest() {
  const keychainToken = await getCursorKeychainToken();
  if (process.platform === "darwin") {
    if (keychainToken) {
      assert.ok(["cli_keychain", "cli_keychain_refresh"].includes(keychainToken.source));
      assert.ok(
        typeof keychainToken.accessToken === "string" && keychainToken.accessToken.length > 0,
      );
    }
  }

  const vscdbToken = await getCursorVscdbToken();
  if (vscdbToken) {
    assert.ok(["ide_vscdb", "ide_vscdb_refresh"].includes(vscdbToken.source));
    assert.ok(typeof vscdbToken.accessToken === "string" && vscdbToken.accessToken.length > 0);
  }

  const resolved = await resolveSystemCursorAccessToken();
  if (keychainToken || vscdbToken) {
    assert.ok(resolved !== undefined);
    assert.ok(typeof resolved.accessToken === "string" && resolved.accessToken.length > 0);
  }

  console.error("test-cli-auth: ok");
}

runTest().catch((err) => {
  console.error("test-cli-auth failed:", err);
  process.exit(1);
});
