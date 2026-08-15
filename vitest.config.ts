import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,mjs}"],
      exclude: ["src/proto/**", "src/**/index.ts", "src/stream/types.ts"],
      thresholds: {
        statements: 35,
        lines: 35,
        functions: 45,
        branches: 60,
      },
    },
  },
});
