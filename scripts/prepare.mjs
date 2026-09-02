/**
 * Lifecycle `prepare` entry: build dist/ for git installs and local `bun install`.
 *
 * npm/Pi git installs have Node but often not Bun. Local development has Bun
 * and may not have Node. This file uses only portable `node:*` APIs so either
 * runtime can execute it, and it bootstraps Bun when the binary is missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_BUN_VERSION = { major: 1, minor: 4, patch: 0 };
export const MIN_BUN_VERSION_LABEL = "1.4.0";

const WINDOWS = process.platform === "win32";
const BUN_BIN = WINDOWS ? "bun.exe" : "bun";

export function parseBunVersion(text) {
  const match = String(text).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function bunVersionAtLeast(version, min = MIN_BUN_VERSION) {
  if (version.major !== min.major) return version.major > min.major;
  if (version.minor !== min.minor) return version.minor > min.minor;
  return version.patch >= min.patch;
}

export function bunHomeBinDir(env = process.env, home = homedir()) {
  const installRoot = env.BUN_INSTALL || join(home, ".bun");
  return join(installRoot, "bin");
}

export function bunHomeBinary(env = process.env, home = homedir()) {
  return join(bunHomeBinDir(env, home), BUN_BIN);
}

function bunVersionOf(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) return null;
  return parseBunVersion(`${result.stdout ?? ""}${result.stderr ?? ""}`);
}

function usableBun(command, args = []) {
  const version = bunVersionOf(command, [...args, "--version"]);
  if (!version || !bunVersionAtLeast(version)) return null;
  return { command, args, version };
}

export function resolveExistingBun(env = process.env, home = homedir()) {
  const homeBin = bunHomeBinary(env, home);
  const pathPrefixed = {
    ...env,
    PATH: `${bunHomeBinDir(env, home)}${WINDOWS ? ";" : ":"}${env.PATH ?? ""}`,
  };

  const fromPath = bunVersionOf("bun");
  if (fromPath && bunVersionAtLeast(fromPath)) {
    return { command: "bun", args: [], version: fromPath };
  }

  if (existsSync(homeBin)) {
    const version = bunVersionOf(homeBin);
    if (version && bunVersionAtLeast(version)) {
      return { command: homeBin, args: [], version, env: pathPrefixed };
    }
  }

  return null;
}

function commandExists(command) {
  const result = WINDOWS
    ? spawnSync("where", [command], { encoding: "utf8" })
    : spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], { encoding: "utf8" });
  return result.status === 0;
}

function installBunViaNpx() {
  if (!commandExists("npx")) return null;
  console.log(`pi-cursor: Bun ${MIN_BUN_VERSION_LABEL}+ not found; installing a local copy via npx…`);
  const spec = `bun@${MIN_BUN_VERSION_LABEL}`;
  return usableBun("npx", ["--yes", spec]);
}

function installBunOfficial() {
  if (process.env.PI_CURSOR_SKIP_BUN_BOOTSTRAP === "1") {
    return { error: "PI_CURSOR_SKIP_BUN_BOOTSTRAP=1 and Bun is not installed" };
  }

  console.log(`pi-cursor: Bun ${MIN_BUN_VERSION_LABEL}+ not found; installing from https://bun.sh …`);

  let result;
  if (WINDOWS) {
    result = spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm bun.sh/install.ps1 | iex"],
      { stdio: "inherit" },
    );
  } else if (commandExists("curl")) {
    const script = spawnSync("curl", ["-fsSL", "https://bun.sh/install"], { encoding: "utf8" });
    if (script.status !== 0) {
      return { error: script.stderr?.trim() || "curl https://bun.sh/install failed" };
    }
    result = spawnSync("bash", ["-s"], {
      input: script.stdout,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } else {
    return { error: "curl is required to install Bun" };
  }

  if (result.status !== 0) {
    return { error: `Bun installer exited ${result.status}` };
  }
  return {};
}

export function ensureBun() {
  const existing = resolveExistingBun();
  if (existing) return existing;

  const viaNpx = installBunViaNpx();
  if (viaNpx) return viaNpx;

  const official = installBunOfficial();
  if (official.error) {
    throw new Error(
      `${official.error}. Install Bun ${MIN_BUN_VERSION_LABEL}+ from https://bun.sh and retry.`,
    );
  }

  const afterInstall = resolveExistingBun();
  if (afterInstall) return afterInstall;

  throw new Error(
    `Bun was installed but is not runnable yet. Add ${bunHomeBinDir()} to PATH (or open a new shell) and retry.`,
  );
}

export function runBuild(bun = ensureBun()) {
  const env = bun.env ? { ...process.env, ...bun.env } : process.env;
  const result = spawnSync(bun.command, [...bun.args, "scripts/build.ts"], {
    stdio: "inherit",
    env,
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    runBuild();
  } catch (error) {
    console.error(`pi-cursor: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
