/**
 * Pi Ctrl+V writes clipboard screenshots to `$TMPDIR/pi-clipboard-<uuid>.<ext>`
 * and inserts that path as plain text. Cursor-native tools otherwise refuse
 * anything outside `process.cwd()`, so this module is the allowlist + ingest
 * path for those files only.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CURSOR_CLI_MAX_IMAGE_BYTES, decodeImageBytes, type ImageDecodeOptions } from "./images.js";
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

function isInsideDir(absPath: string, root: string): boolean {
  const relative = path.relative(root, absPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * `$TMPDIR/<clipboard-basename>` without following the file itself as a symlink.
 * The parent directory may be realpath'd; a symlink at the leaf is rejected at open.
 */
export function resolvedPiClipboardImagePath(absPath: string): string | undefined {
  const base = path.basename(absPath);
  if (!PI_CLIPBOARD_IMAGE_NAME.test(base)) return undefined;
  const dir = path.dirname(path.resolve(absPath));
  let realDir: string;
  try {
    realDir = existsSync(dir) ? realpathSync(dir) : path.resolve(dir);
  } catch {
    return undefined;
  }
  if (!isInsideDir(realDir, tmpRoot())) return undefined;
  return path.join(realDir, base);
}

/** True when `absPath` is a Pi clipboard image sitting under the process temp dir. */
export function isPiClipboardImagePath(absPath: string): boolean {
  const resolved = resolvedPiClipboardImagePath(absPath);
  if (!resolved) return false;
  try {
    if (!existsSync(resolved)) return true;
    const lst = lstatSync(resolved);
    return lst.isFile() && !lst.isSymbolicLink();
  } catch {
    return false;
  }
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

export type ClipboardImageRead = Uint8Array | "oversized" | undefined;

/**
 * Open a Pi clipboard image without following a leaf symlink. Size is taken from
 * the opened descriptor before any payload is allocated.
 */
export function readPiClipboardImageBytes(absPath: string): ClipboardImageRead {
  const resolved = resolvedPiClipboardImagePath(absPath);
  if (!resolved) return undefined;
  let fd: number | undefined;
  try {
    const lst = lstatSync(resolved);
    if (lst.isSymbolicLink() || !lst.isFile()) return undefined;
    if (lst.size > CURSOR_CLI_MAX_IMAGE_BYTES) return "oversized";
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    fd = openSync(resolved, flags);
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    if (st.size > CURSOR_CLI_MAX_IMAGE_BYTES) return "oversized";
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    return new Uint8Array(buf.subarray(0, n));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
    if (!isPiClipboardImagePath(resolved)) continue;
    const bytes = readPiClipboardImageBytes(resolved);
    if (bytes === "oversized") {
      if (options.enforceCursorCliLimits && !options.dropInvalid) {
        throw new Error(
          `Image exceeds Cursor CLI's ${CURSOR_CLI_MAX_IMAGE_BYTES} byte limit after processing.`,
        );
      }
      continue;
    }
    if (!bytes) continue;
    const image = decodeImageBytes(bytes, options);
    if (image) images.push(image);
  }
  return images;
}
