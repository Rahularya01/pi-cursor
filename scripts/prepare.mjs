import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, "dist/index.js"))) process.exit(0);

const win = process.platform === "win32";
const tsup = join(root, "node_modules", ".bin", win ? "tsup.cmd" : "tsup");
const useLocal = existsSync(tsup);
const result = spawnSync(useLocal ? tsup : win ? "npx.cmd" : "npx", useLocal ? [] : ["--yes", "tsup"], {
  stdio: "inherit",
  cwd: root,
  shell: win,
});
process.exit(result.status ?? 1);
