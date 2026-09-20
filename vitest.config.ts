import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/proto/**", "src/**/index.ts", "src/stream/types.ts"],
      thresholds: {
        lines: 35,
        statements: 35,
        functions: 45,
        branches: 60,
      },
    },
  },
});
