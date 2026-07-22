/**
 * Live models smoke.
 * Usage: CURSOR_ACCESS_TOKEN=... node --import tsx scripts/smoke-models.mjs
 */
import { getCursorModels, getCursorParameterizedModels } from "../src/stream/native-core.ts";

const token = process.env.CURSOR_ACCESS_TOKEN?.trim();
if (!token) {
  console.error("Set CURSOR_ACCESS_TOKEN (or run /login cursor and copy access from auth.json)");
  process.exit(1);
}

const [models, parameterized] = await Promise.all([
  getCursorModels(token),
  getCursorParameterizedModels(token),
]);
console.log("usable models:", models.length);
console.log("parameterized models:", parameterized.length);
console.log(
  models
    .slice(0, 12)
    .map((m) => m.id)
    .join("\n"),
);
console.log("smoke-models: ok");
