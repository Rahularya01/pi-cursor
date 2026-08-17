import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { imageKey, mergeImages } from "../src/stream/images.js";
import type { ParsedImageContent } from "../src/stream/types.js";

const image = (fill: number, byteLength: number, mimeType = "image/png"): ParsedImageContent => ({
  data: new Uint8Array(Buffer.alloc(byteLength, fill)),
  mimeType,
});

/**
 * `mergeImages` buckets on (mimeType, byteLength) and only digests payloads that collide on
 * that shape, so the identity it enforces is not obvious from the implementation alone. These
 * pin it to the original contract: dedup iff same MIME type *and* same bytes.
 */
describe("mergeImages", () => {
  it("drops duplicates with identical mime type and bytes", () => {
    expect(mergeImages([image(1, 64), image(1, 64)])).toHaveLength(1);
  });

  it("keeps same-length images whose content differs", () => {
    expect(mergeImages([image(1, 64), image(2, 64)])).toHaveLength(2);
  });

  it("keeps identical bytes carrying different mime types", () => {
    const merged = mergeImages([image(1, 64, "image/png"), image(1, 64, "image/jpeg")]);
    expect(merged).toHaveLength(2);
  });

  it("dedups across separate groups and skips undefined ones", () => {
    const merged = mergeImages([image(3, 32)], undefined, [image(3, 32), image(4, 32)]);
    expect(merged).toHaveLength(2);
  });

  it("preserves first-seen order", () => {
    const merged = mergeImages([image(5, 16), image(6, 8), image(5, 16)])!;
    expect(merged.map((i) => i.data.byteLength)).toEqual([16, 8]);
  });

  it("returns undefined when nothing survives", () => {
    expect(mergeImages(undefined, [])).toBeUndefined();
  });

  it("matches a content-addressed reference implementation", () => {
    const reference = (groups: Array<ParsedImageContent[] | undefined>): ParsedImageContent[] => {
      const seen = new Set<string>();
      const out: ParsedImageContent[] = [];
      for (const group of groups) {
        for (const img of group ?? []) {
          const key = `${img.mimeType}:${createHash("sha256").update(img.data).digest("hex")}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(img);
        }
      }
      return out;
    };

    // Deterministic sweep over every combination of mime / length / content that can collide.
    const mimes = ["image/png", "image/jpeg"];
    for (let trial = 0; trial < 200; trial += 1) {
      const groups: Array<ParsedImageContent[] | undefined> = [];
      for (let g = 0; g < 3; g += 1) {
        const size = (trial * 7 + g * 3) % 5;
        if (size === 0) {
          groups.push(undefined);
          continue;
        }
        groups.push(
          Array.from({ length: size }, (_, i) => {
            const s = trial * 13 + g * 5 + i * 17;
            return image((s % 2) + 1, ((s >> 1) % 2) + 1, mimes[(s >> 2) % 2]!);
          }),
        );
      }
      const expected = reference(groups);
      expect(mergeImages(...groups) ?? []).toEqual(expected);
    }
  });

  it("keys an image by mime type and content digest", () => {
    expect(imageKey(image(1, 64))).toEqual(imageKey(image(1, 64)));
    expect(imageKey(image(1, 64))).not.toEqual(imageKey(image(2, 64)));
    expect(imageKey(image(1, 64, "image/png"))).not.toEqual(imageKey(image(1, 64, "image/jpeg")));
  });
});
