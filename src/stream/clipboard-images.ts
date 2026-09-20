/**
 * Pi Ctrl+V writes clipboard screenshots to `$TMPDIR/pi-clipboard-<uuid>.<ext>`
 * and inserts that path as plain text. Cursor-native tools otherwise refuse
 * anything outside `process.cwd()`, so this module is the allowlist + ingest
 * path for those files only.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decodeImageBytes, type ImageDecodeOptions } from "./images.js";
import type { ParsedImageContent } from "./types.js";

export const PI_CLIPBOARD_IMAGE_NAME =
  /^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|gif|webp)$/i;

const CLIPBOARD_NAME_IN_TEXT =
  /pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)/gi;

function tmpRoot(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return path.resolve(tmpdir());
  }
}

function comparablePath(candidate: string): string {
  try {
    if (existsSync(candidate)) return realpathSync(candidate);
  } catch {
    /* keep unresolved */
  }
  return candidate;
}

function isInsideDir(absPath: string, root: string): boolean {
  const relative = path.relative(root, absPath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** True when `absPath` is a Pi clipboard image sitting under the process temp dir. */
export function isPiClipboardImagePath(absPath: string): boolean {
  if (!PI_CLIPBOARD_IMAGE_NAME.test(path.basename(absPath))) return false;
  return isInsideDir(comparablePath(absPath), tmpRoot());
}

/** Paths mentioned in user text whose basename is a Pi clipboard image. */
export function clipboardImagePathsInText(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CLIPBOARD_NAME_IN_TEXT)) {
    const end = (match.index ?? 0) + match[0].length;
    let start = match.index ?? 0;
    while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
    const found = text.slice(start, end);
    if (seen.has(found)) continue;
    seen.add(found);
    paths.push(found);
  }
  return paths;
}

/**
 * Load Pi clipboard images referenced in user text. Missing files are skipped.
 * Oversized / unsupported images follow `ImageDecodeOptions` (throw vs drop).
 */
export function loadClipboardImagesFromText(
  text: string,
  options: ImageDecodeOptions = {},
): ParsedImageContent[] {
  const images: ParsedImageContent[] = [];
  for (const rawPath of clipboardImagePathsInText(text)) {
    const resolved = path.resolve(rawPath);
    if (!isPiClipboardImagePath(resolved) || !existsSync(resolved)) continue;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(resolved));
    } catch {
      continue;
    }
    const image = decodeImageBytes(bytes, options);
    if (image) images.push(image);
  }
  return images;
}
