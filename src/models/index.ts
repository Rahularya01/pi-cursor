/** Re-export catalog JSON for external tooling. Prefer provider registration via src/index.ts. */
export { default as catalog } from "./catalog.json" with { type: "json" };
export * from "./cost.js";
export * from "./processing.js";
export * from "./parameterized.js";
