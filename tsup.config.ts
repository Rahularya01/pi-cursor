import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  minify: true,
  sourcemap: false,
  clean: true,
  dts: false,
  splitting: false,
  treeshake: true,
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@bufbuild/protobuf"],
});
