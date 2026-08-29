/**
 * Bundles the extension to a single minified ESM file in dist/ (replaces tsup).
 *
 * The generated proto module (src/proto/agent_pb.ts) exports ~1000 symbols but
 * only ~70 are used; tree-shaking drops the rest, which is where most of the
 * size win comes from.
 *
 * `target: "node"` is deliberate even though the toolchain and only supported
 * host runtime is Bun: it keeps dist/ using only standard, portable APIs
 * (`node:http2` included) rather than baking in Bun-only builtins.
 */
import { rm } from "node:fs/promises";

const OUT_DIR = "dist";

// Real runtime deps resolved from node_modules, not inlined.
const EXTERNAL = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@bufbuild/protobuf",
];

await rm(OUT_DIR, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: OUT_DIR,
  target: "node",
  format: "esm",
  minify: true,
  splitting: false,
  sourcemap: "none",
  external: EXTERNAL,
  naming: "[dir]/[name].js",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  console.error("\nBuild failed.");
  process.exit(1);
}

for (const output of result.outputs) {
  const kb = (output.size / 1024).toFixed(1);
  console.log(`  ${output.path.replace(`${process.cwd()}/`, "")}  ${kb} KB`);
}
