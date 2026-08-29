import { afterEach, describe, expect, it, vi } from "bun:test";
import {
  getApiProvider,
  registerApiProvider,
  unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import { CURSOR_NATIVE_API, FALLBACK_MODELS, modelConfig, processModels } from "../src/index.js";

const SOURCE = "test:@rahularya01/pi-cursor";

afterEach(() => {
  unregisterApiProviders(SOURCE);
});

describe("cursor-native API registration", () => {
  it("exposes a stable custom api id on every model config", () => {
    const models = processModels(FALLBACK_MODELS).slice(0, 5);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(modelConfig(model).api).toBe(CURSOR_NATIVE_API);
    }
  });

  it("is discoverable via the global compat registry after registerApiProvider", () => {
    const streamSimple = vi.fn();
    registerApiProvider(
      {
        api: CURSOR_NATIVE_API,
        stream: streamSimple,
        streamSimple,
      },
      SOURCE,
    );

    const provider = getApiProvider(CURSOR_NATIVE_API);
    expect(provider).toBeDefined();
    expect(provider?.api).toBe(CURSOR_NATIVE_API);
    expect(typeof provider?.streamSimple).toBe("function");
    expect(typeof provider?.stream).toBe("function");
  });
});
