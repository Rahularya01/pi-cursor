import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bunVersion = String(
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager ?? "",
).replace(/^bun@/, "");
if (!bunVersion) {
  console.error("pi-cursor: could not read packageManager bun version from package.json");
  process.exit(1);
}

const win = process.platform === "win32";
const bunHome = join(
  process.env.BUN_INSTALL || join(homedir(), ".bun"),
  "bin",
  win ? "bun.exe" : "bun",
);

function run(command, args, opts = {}) {
  return spawnSync(command, args, { stdio: "inherit", cwd: root, ...opts });
}

function isSupportedBun(cmd) {
  try {
    const res = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (res.status !== 0 || !res.stdout) return false;
    const version = res.stdout.trim().replace(/^v/, "");
    const [major, minor] = version.split(".").map(Number);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
    return major > 1 || (major === 1 && minor >= 4);
  } catch {
    return false;
  }
}

function findBun() {
  if (isSupportedBun("bun")) return "bun";
  if (existsSync(bunHome) && isSupportedBun(bunHome)) {
    return bunHome;
  }
  return null;
}

const bun = findBun();
if (bun) process.exit(run(bun, ["scripts/build.ts"]).status ?? 1);

console.log(`pi-cursor: Bun not found; using bun@${bunVersion} via npx`);
const npx = win ? "npx.cmd" : "npx";
const built = run(npx, ["--yes", `bun@${bunVersion}`, "scripts/build.ts"], { shell: win });
if (built.status === 0) process.exit(0);

console.error(
  `pi-cursor: Bun ${bunVersion} is required to build. Install it from https://bun.sh and retry.`,
);
process.exit(1);
