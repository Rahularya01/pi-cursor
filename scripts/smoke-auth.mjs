/**
 * Live auth smoke: requires interactive browser.
 * Usage: node --import tsx scripts/smoke-auth.mjs
 */
import { generateCursorAuthParams, pollCursorAuth, getTokenExpiry } from "../src/auth/oauth.ts";

const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
console.log("Open this URL to sign in:\n", loginUrl);
console.log("Waiting for poll…");
const tokens = await pollCursorAuth(uuid, verifier);
console.log("access expires", new Date(getTokenExpiry(tokens.accessToken)).toISOString());
console.log("refresh present", Boolean(tokens.refreshToken));
console.log("smoke-auth: ok");
