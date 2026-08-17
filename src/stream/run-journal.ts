/**
 * Disk-backed journal for conversation recovery state.
 *
 * In-memory maps alone die with the process and evaporate across long sessions
 * when the bridge is lost. The journal stores the minimum needed to resume a
 * parked tool turn or continue from the latest checkpoint after transport loss.
 *
 * Storage is best-effort: if the cache dir is unusable we stay memory-only.
 */
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join as pathJoin } from "node:path";

import { getCacheDir } from "../utils/cache-dir.js";
import { debugLog } from "./debug-log.js";
import { MAX_INDIVIDUAL_BLOB_BYTES } from "./tuning.js";
import type { StoredConversation } from "./types.js";

const JOURNAL_VERSION = 1 as const;
const JOURNAL_SUBDIR = "run-journal";
const JOURNAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_JOURNAL_FILE_BYTES = 192 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const MAX_ENCODED_BLOB_CHARS = Math.ceil((MAX_INDIVIDUAL_BLOB_BYTES * 4) / 3) + 4;

interface JournalBlobEntry {
  id: string;
  /** base64 */
  data: string;
}

export interface DurableJournalRecord {
  version: typeof JOURNAL_VERSION;
  convKey: string;
  savedAt: number;
  conversationId: string;
  sessionScoped: boolean;
  sessionId?: string;
  /** base64 checkpoint bytes */
  checkpoint: string | null;
  checkpointSource?: "upstream" | "absent";
  checkpointTurnCount?: number;
  checkpointHistoryFingerprint?: string;
  midPausePendingToolCalls?: Array<{ toolCallId: string; toolName: string }>;
  midPauseTurnCount?: number;
  midPauseHistoryFingerprint?: string;
  midPauseRecordedAtMs?: number;
  /** Content-addressed blobs referenced by checkpoints / history. */
  blobs: JournalBlobEntry[];
  lastAccessMs: number;
}

function journalDir(): string | undefined {
  const base = getCacheDir();
  if (!base) return undefined;
  const dir = pathJoin(base, JOURNAL_SUBDIR);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return undefined;
  }
}

function journalPath(convKey: string): string | undefined {
  const dir = journalDir();
  if (!dir) return undefined;
  // convKey is already a short hex hash; keep the filename boring.
  const safe = convKey.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  return pathJoin(dir, `${safe}.json`);
}

/**
 * Enough to cover `{"version":1,"convKey":"<=64 chars>","savedAt":<ms>` with room to spare.
 * `convKey` is sanitized to `[a-zA-Z0-9._-]`, so it can never contain a quoted key itself —
 * the first `"savedAt":` in the prefix is always the real field.
 */
const SAVED_AT_PROBE_BYTES = 512;
const SAVED_AT_PATTERN = /"savedAt":\s*(\d+)/;

interface JournalStat {
  size: number;
  /** `savedAt` when it was readable from the file's head, else undefined. */
  savedAt?: number;
}

/**
 * Stat a journal and recover its `savedAt` without reading the whole file.
 *
 * Blobs are base64 and sit at the tail of the record, so a journal is routinely megabytes
 * while the timestamp the TTL sweep needs lives in the first hundred bytes. Reading a fixed
 * prefix keeps `evictStaleJournals` proportional to the number of journals rather than to
 * their total size.
 */
function statJournalHead(path: string): JournalStat | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const head = Buffer.allocUnsafe(Math.min(SAVED_AT_PROBE_BYTES, size));
    const read = head.length > 0 ? readSync(fd, head, 0, head.length, 0) : 0;
    const savedAt = Number(SAVED_AT_PATTERN.exec(head.toString("utf8", 0, read))?.[1]);
    return { size, ...(Number.isFinite(savedAt) && savedAt > 0 ? { savedAt } : {}) };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed / never opened.
      }
    }
  }
}

// A journal is rewritten on every checkpoint commit and every tool-call pause, but a
// conversation's blobs are overwhelmingly carried over unchanged from the previous write.
// Blob bytes are immutable once stored, so cache each buffer's encoding by identity rather
// than re-encoding megabytes of base64 per pause.
const blobBase64Cache = new WeakMap<Uint8Array, string>();

function encodeBlob(data: Uint8Array): string {
  let encoded = blobBase64Cache.get(data);
  if (encoded === undefined) {
    encoded = Buffer.from(data).toString("base64");
    blobBase64Cache.set(data, encoded);
  }
  return encoded;
}

function encodeBlobs(blobStore: Map<string, Uint8Array>, maxBlobs = 64): JournalBlobEntry[] {
  const entries: JournalBlobEntry[] = [];
  // Map iteration is insertion order; keep the newest tail under the cap.
  const all = [...blobStore.entries()];
  const slice = all.length > maxBlobs ? all.slice(all.length - maxBlobs) : all;
  for (const [id, data] of slice) {
    entries.push({ id, data: encodeBlob(data) });
  }
  return entries;
}

function decodeBlobs(entries: JournalBlobEntry[] | undefined): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  if (!Array.isArray(entries)) return map;
  for (const entry of entries.slice(0, 64)) {
    try {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        !entry.id ||
        typeof entry.data !== "string" ||
        entry.data.length > MAX_ENCODED_BLOB_CHARS
      ) {
        continue;
      }
      const data = Buffer.from(entry.data, "base64");
      if (data.length > MAX_INDIVIDUAL_BLOB_BYTES) continue;
      map.set(entry.id, new Uint8Array(data));
    } catch {
      // Skip corrupt blob entries.
    }
  }
  return map;
}

export function serializeConversationJournal(
  convKey: string,
  stored: StoredConversation,
  now = Date.now(),
): DurableJournalRecord {
  return {
    version: JOURNAL_VERSION,
    convKey,
    savedAt: now,
    conversationId: stored.conversationId,
    sessionScoped: stored.sessionScoped,
    ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
    checkpoint: stored.checkpoint ? Buffer.from(stored.checkpoint).toString("base64") : null,
    ...(stored.checkpointSource ? { checkpointSource: stored.checkpointSource } : {}),
    ...(stored.checkpointTurnCount !== undefined
      ? { checkpointTurnCount: stored.checkpointTurnCount }
      : {}),
    ...(stored.checkpointHistoryFingerprint
      ? { checkpointHistoryFingerprint: stored.checkpointHistoryFingerprint }
      : {}),
    ...(stored.midPausePendingToolCalls
      ? { midPausePendingToolCalls: stored.midPausePendingToolCalls }
      : {}),
    ...(stored.midPauseTurnCount !== undefined
      ? { midPauseTurnCount: stored.midPauseTurnCount }
      : {}),
    ...(stored.midPauseHistoryFingerprint
      ? { midPauseHistoryFingerprint: stored.midPauseHistoryFingerprint }
      : {}),
    ...(stored.midPauseRecordedAtMs !== undefined
      ? { midPauseRecordedAtMs: stored.midPauseRecordedAtMs }
      : {}),
    blobs: encodeBlobs(stored.blobStore),
    lastAccessMs: stored.lastAccessMs || now,
  };
}

export function deserializeConversationJournal(
  record: DurableJournalRecord,
): StoredConversation | undefined {
  if (!record || typeof record !== "object") return undefined;
  if (record.version !== JOURNAL_VERSION) return undefined;
  if (typeof record.conversationId !== "string" || typeof record.convKey !== "string") {
    return undefined;
  }

  let checkpoint: Uint8Array | null = null;
  if (record.checkpoint) {
    try {
      if (typeof record.checkpoint !== "string") return undefined;
      const decoded = Buffer.from(record.checkpoint, "base64");
      if (decoded.length > MAX_CHECKPOINT_BYTES) return undefined;
      checkpoint = new Uint8Array(decoded);
    } catch {
      checkpoint = null;
    }
  }

  return {
    conversationId: record.conversationId,
    checkpoint,
    ...(record.checkpointSource ? { checkpointSource: record.checkpointSource } : {}),
    ...(record.checkpointTurnCount !== undefined
      ? { checkpointTurnCount: record.checkpointTurnCount }
      : {}),
    ...(record.checkpointHistoryFingerprint
      ? { checkpointHistoryFingerprint: record.checkpointHistoryFingerprint }
      : {}),
    ...(record.midPausePendingToolCalls
      ? { midPausePendingToolCalls: record.midPausePendingToolCalls }
      : {}),
    ...(record.midPauseTurnCount !== undefined
      ? { midPauseTurnCount: record.midPauseTurnCount }
      : {}),
    ...(record.midPauseHistoryFingerprint
      ? { midPauseHistoryFingerprint: record.midPauseHistoryFingerprint }
      : {}),
    ...(record.midPauseRecordedAtMs !== undefined
      ? { midPauseRecordedAtMs: record.midPauseRecordedAtMs }
      : {}),
    sessionScoped: !!record.sessionScoped,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    blobStore: decodeBlobs(record.blobs),
    lastAccessMs: record.lastAccessMs || record.savedAt || Date.now(),
  };
}

/** Persist a conversation snapshot. Best-effort; never throws to callers. */
export function writeConversationJournal(convKey: string, stored: StoredConversation): boolean {
  const path = journalPath(convKey);
  if (!path) return false;
  try {
    const record = serializeConversationJournal(convKey, stored);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    debugLog("journal.write", {
      convKey,
      hasCheckpoint: !!stored.checkpoint,
      midPause: !!stored.midPausePendingToolCalls?.length,
      blobCount: stored.blobStore.size,
    });
    return true;
  } catch (error) {
    debugLog("journal.write_failed", {
      convKey,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Load a conversation snapshot from disk, or undefined when missing/stale/corrupt. */
export function readConversationJournal(
  convKey: string,
  options?: { maxAgeMs?: number; now?: number },
): StoredConversation | undefined {
  const path = journalPath(convKey);
  if (!path) return undefined;
  try {
    const head = statJournalHead(path);
    if (!head) return undefined;
    if (head.size > MAX_JOURNAL_FILE_BYTES) {
      debugLog("journal.oversized", { convKey });
      return undefined;
    }
    const now = options?.now ?? Date.now();
    const maxAge = options?.maxAgeMs ?? JOURNAL_TTL_MS;
    // Reject a stale journal from its head rather than decoding megabytes of blobs first.
    if (head.savedAt !== undefined) {
      const headAge = now - head.savedAt;
      if (headAge < 0 || headAge > maxAge) {
        debugLog("journal.stale", { convKey, age: headAge });
        return undefined;
      }
    }
    const raw = readFileSync(path, "utf8");
    const record = JSON.parse(raw) as DurableJournalRecord;
    const age = now - (record.savedAt || record.lastAccessMs || 0);
    if (!Number.isFinite(age) || age < 0 || age > maxAge) {
      debugLog("journal.stale", { convKey, age });
      return undefined;
    }
    const stored = deserializeConversationJournal(record);
    if (!stored) return undefined;
    debugLog("journal.read", {
      convKey,
      hasCheckpoint: !!stored.checkpoint,
      midPause: !!stored.midPausePendingToolCalls?.length,
    });
    return stored;
  } catch {
    return undefined;
  }
}

export function deleteConversationJournal(convKey: string): void {
  const path = journalPath(convKey);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // absent is fine
  }
}

/** Drop journals older than TTL. Called opportunistically on write/load paths. */
export function evictStaleJournals(now = Date.now(), maxAgeMs = JOURNAL_TTL_MS): number {
  const dir = journalDir();
  if (!dir) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const full = pathJoin(dir, name);
      try {
        const head = statJournalHead(full);
        if (!head) throw new Error("unreadable journal");
        if (head.size > MAX_JOURNAL_FILE_BYTES) {
          unlinkSync(full);
          removed += 1;
          continue;
        }
        // The head carries `savedAt` for every journal this build writes, so the common
        // sweep never reads a blob payload. Anything older, hand-edited, or truncated
        // falls through to the full parse below.
        let age: number;
        if (head.savedAt !== undefined) {
          age = now - head.savedAt;
        } else {
          const record = JSON.parse(readFileSync(full, "utf8")) as DurableJournalRecord;
          age = now - (record.savedAt || record.lastAccessMs || 0);
        }
        if (!Number.isFinite(age) || age > maxAgeMs) {
          unlinkSync(full);
          removed += 1;
        }
      } catch {
        try {
          unlinkSync(full);
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    return removed;
  }
  if (removed > 0) debugLog("journal.evict", { removed });
  return removed;
}

export const __testInternals = {
  JOURNAL_VERSION,
  JOURNAL_TTL_MS,
  MAX_JOURNAL_FILE_BYTES,
  serializeConversationJournal,
  deserializeConversationJournal,
  journalPath,
};
