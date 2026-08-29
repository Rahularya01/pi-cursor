import { afterEach, describe, expect, it, jest, mock, vi } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerCursorCommands } from "../src/extension/commands.js";
import type { ProcessedModel } from "../src/models/processing.js";
import { CredentialSource } from "../src/types/enums.js";
import * as usageModule from "../src/usage.js";

// bun:test has no vi.mock factory with importOriginal. mock.module patches the
// live ESM bindings of modules that already imported usage.js (commands.js
// above), so spreading the real module keeps every other export intact.
const getCursorUsageSummary = jest.fn<typeof usageModule.getCursorUsageSummary>();
await mock.module("../src/usage.js", () => ({
  ...usageModule,
  getCursorUsageSummary,
}));

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function registerHandlers(): Map<string, CommandHandler> {
  const handlers = new Map<string, CommandHandler>();
  const pi = {
    registerCommand(name: string, spec: { handler: CommandHandler }) {
      handlers.set(name, spec.handler);
    },
  } as unknown as ExtensionAPI;

  registerCursorCommands(pi, {
    getAccessToken: async () => "token",
    getLastRegisteredModels: () =>
      [
        {
          id: "composer-1.5",
          name: "Composer 1.5",
          contextWindow: 200000,
          supportsImages: false,
          supportsEffort: true,
          effortMap: { high: "high" },
        },
      ] as unknown as ProcessedModel[],
    getCurrentTokenSource: () => CredentialSource.None,
  });

  return handlers;
}

function uiContext(notify = vi.fn()): ExtensionCommandContext {
  return {
    hasUI: true,
    ui: { notify },
  } as unknown as ExtensionCommandContext;
}

function headlessContext(): ExtensionCommandContext {
  return { hasUI: false } as unknown as ExtensionCommandContext;
}

describe("cursor command output routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getCursorUsageSummary.mockReset();
  });

  it("sends /cursor.models through notify only when a UI is present", async () => {
    const handlers = registerHandlers();
    const notify = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handlers.get("cursor.models")!("", uiContext(notify));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatch(/composer-1\.5/);
    expect(notify.mock.calls[0]?.[1]).toBe("info");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("prints /cursor.models to stdout when no UI is present", async () => {
    const handlers = registerHandlers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handlers.get("cursor.models")!("", headlessContext());

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/composer-1\.5/);
    expect(error).not.toHaveBeenCalled();
  });

  it("sends /cursor.usage through notify only when a UI is present", async () => {
    getCursorUsageSummary.mockResolvedValue({
      membershipType: "Pro",
    } as Awaited<ReturnType<typeof getCursorUsageSummary>>);
    const handlers = registerHandlers();
    const notify = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handlers.get("cursor.usage")!("", uiContext(notify));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[1]).toBe("info");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("sends /cursor.usage errors through notify only when a UI is present", async () => {
    getCursorUsageSummary.mockRejectedValue(new Error("quota boom"));
    const handlers = registerHandlers();
    const notify = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handlers.get("cursor.usage")!("", uiContext(notify));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatch(/quota boom/);
    expect(notify.mock.calls[0]?.[1]).toBe("error");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("prints /cursor.usage errors to stderr when no UI is present", async () => {
    getCursorUsageSummary.mockRejectedValue(new Error("quota boom"));
    const handlers = registerHandlers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handlers.get("cursor.usage")!("", headlessContext());

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/quota boom/);
    expect(log).not.toHaveBeenCalled();
  });

  it("sends /cursor.doctor through notify only when a UI is present", async () => {
    const handlers = registerHandlers();
    const notify = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handlers.get("cursor.doctor")!("", uiContext(notify));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatch(/Cursor doctor/);
    expect(notify.mock.calls[0]?.[1]).toBe("info");
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
