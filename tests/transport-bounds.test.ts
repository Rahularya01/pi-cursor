import { describe, expect, it } from "vitest";

import { createConnectFrameParser, MAX_CONNECT_MESSAGE_BYTES } from "../src/client/bridge.js";
import { decodeBase64Image } from "../src/stream/images.js";

describe("transport input bounds", () => {
  it("rejects oversized declared Connect frames before buffering their bodies", () => {
    const parser = createConnectFrameParser(
      () => {},
      () => {},
    );
    const header = Buffer.alloc(5);
    header.writeUInt32BE(MAX_CONNECT_MESSAGE_BYTES + 1, 1);
    expect(() => parser(header)).toThrow(/exceeds/);
  });

  it("rejects oversized inline images before base64 decoding", () => {
    const oversized = "A".repeat(Math.ceil((5_242_880 * 4) / 3) + 1025);
    expect(() =>
      decodeBase64Image(oversized, "image/png", { enforceCursorCliLimits: true }),
    ).toThrow(/encoded limit/);
  });
});
