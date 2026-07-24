/**
 * Image decoding and validation for the Cursor wire format.
 *
 * Cursor CLI's local-image path scales/compresses images to <= 5 MiB and
 * accepts only jpeg/png/gif/webp by magic bytes, so anything we forward has to
 * clear the same bar. Pure helpers with no logging, so any module may import it.
 */
import { createHash } from "node:crypto";

import type { ParsedImageContent } from "./types.js";

// Cursor CLI's local-image path scales/compresses images to <= 5 MiB
// and accepts only jpeg/png/gif/webp by magic bytes.
export const CURSOR_CLI_MAX_IMAGE_BYTES = 5_242_880;

export const CURSOR_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export interface ImageDecodeOptions {
  enforceCursorCliLimits?: boolean;
}

export function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

export function sniffCursorImageMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return undefined;
}

export function validateCursorCliImageLimits(bytes: Uint8Array): string {
  if (bytes.length > CURSOR_CLI_MAX_IMAGE_BYTES) {
    throw new Error(
      `Image exceeds Cursor CLI's ${CURSOR_CLI_MAX_IMAGE_BYTES} byte limit after processing.`,
    );
  }
  const sniffedMimeType = sniffCursorImageMimeType(bytes);
  if (!sniffedMimeType || !CURSOR_SUPPORTED_IMAGE_MIME_TYPES.has(sniffedMimeType)) {
    throw new Error("Unsupported image type: supported formats are jpeg, png, gif, or webp.");
  }
  return sniffedMimeType;
}

export function decodeBase64Image(
  data: string,
  mimeType: string,
  options: ImageDecodeOptions = {},
): ParsedImageContent | undefined {
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  if (!normalizedMimeType.startsWith("image/")) return undefined;
  const base64 = data.replace(/\s/g, "");
  if (!base64) return undefined;
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length === 0) return undefined;
  const finalMimeType = options.enforceCursorCliLimits
    ? validateCursorCliImageLimits(bytes)
    : normalizedMimeType;
  return { data: bytes, mimeType: finalMimeType };
}

export function parseImageDataUrl(
  url: string,
  options: ImageDecodeOptions = {},
): ParsedImageContent | undefined {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      "Remote image URLs are not supported by pi-cursor-provider. Attach the image or send an inline data:image/...;base64,... URL.",
    );
  }
  if (!trimmed.startsWith("data:")) {
    throw new Error(
      "Only inline data:image/...;base64,... image_url values are supported by pi-cursor-provider.",
    );
  }
  const match = trimmed.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is);
  if (!match) {
    throw new Error("Unsupported image_url format. Expected data:image/...;base64,...");
  }
  const image = decodeBase64Image(match[2]!, match[1]!, options);
  if (!image) {
    throw new Error("Unsupported image_url MIME type. Expected data:image/...;base64,...");
  }
  return image;
}

export function imageKey(image: ParsedImageContent): string {
  return `${image.mimeType}:${createHash("sha256").update(image.data).digest("hex")}`;
}

export function mergeImages(
  ...groups: Array<ParsedImageContent[] | undefined>
): ParsedImageContent[] | undefined {
  const merged: ParsedImageContent[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const image of group ?? []) {
      const key = imageKey(image);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(image);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

export function cloneParsedImage(image: ParsedImageContent): ParsedImageContent {
  return { data: new Uint8Array(image.data), mimeType: image.mimeType };
}
