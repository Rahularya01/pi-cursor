import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const forbidden = [
  /sk-[a-zA-Z0-9]{20,}/,
  /ya29\.[A-Za-z0-9._~+/-]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js|json|md)$/.test(name)) out.push(p);
  }
  return out;
}

let failed = false;
for (const file of walk(root)) {
  const text = readFileSync(file, "utf8");
  for (const re of forbidden) {
    if (re.test(text) && !file.endsWith("security-check.ts")) {
      console.error(`Possible secret in ${file} matching ${re}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("security-check: ok");
