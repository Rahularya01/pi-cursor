import { defineConfig } from "tsup";

// Bundles the extension to a single minified ESM file in dist/. The generated
// proto module (src/proto/agent_pb.ts) exports ~1000 symbols but only ~70 are
// used; tree-shaking drops the rest, which is where most of the size win comes
// from. h2-bridge.mjs is spawned as a child process by path, so it is copied
// verbatim next to the bundle rather than inlined.
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node18",
  bundle: true,
  treeshake: true,
  minify: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  clean: true,
  // Real runtime deps resolved from node_modules, not inlined.
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@bufbuild/protobuf"],
  outExtension: () => ({ js: ".js" }),
  onSuccess: "cp src/client/h2-bridge.mjs dist/h2-bridge.mjs",
});
