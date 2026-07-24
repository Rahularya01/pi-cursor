/**
 * Conversation state that outlives a single bridge: checkpoints, blob stores,
 * mid-pause snapshots, and the keys everything is filed under.
 *
 * A Cursor turn can lose its bridge while parked waiting for tool results. What
 * survives that is stored here — an upstream checkpoint when we have one, plus
 * enough history fingerprinting for ./recovery.ts to decide between resuming
 * from the checkpoint and rebuilding the whole conversation.
 *
 * Entries are keyed by Pi session id when available, falling back to a hash of
 * the message history, and are evicted on a TTL so an abandoned session cannot
 * pin its blob store forever.
 */
import { createHash } from "node:crypto";

import { activeBridges, cleanupBridge } from "./bridge-session.js";
import { debugLog } from "./debug-log.js";
import { textContent } from "./message-parsing.js";
import {
  clearStoredMidPauseMetadata as clearStoredMidPauseMetadataImpl,
  fingerprintCompletedTurns as fingerprintCompletedTurnsImpl,
} from "./recovery.js";
import { CONVERSATION_TTL_MS, MAX_CONVERSATION_BLOB_BYTES } from "./tuning.js";
import type {
  ChatCompletionRequest,
  OpenAIMessage,
  ParsedTurn,
  StoredConversation,
} from "./types.js";

export const conversationStates = new Map<string, StoredConversation>();

const sessionLocks = new Map<string, Promise<void>>();

export function cleanupAllSessionState(): void {
  debugLog("session.cleanup_all", {
    activeBridgeCount: activeBridges.size,
    conversationCount: conversationStates.size,
  });
  for (const [bridgeKey, active] of activeBridges) {
    cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  }
  conversationStates.clear();
}

export function evictStaleConversations(now = Date.now()): void {
  for (const [key, stored] of conversationStates) {
    if (!stored.sessionScoped && now - stored.lastAccessMs > CONVERSATION_TTL_MS) {
      debugLog("conversation.evict", { key, stored, now });
      conversationStates.delete(key);
    }
  }
}

export function fingerprintCompletedTurns(turns: ParsedTurn[]): string {
  return fingerprintCompletedTurnsImpl(turns);
}

export function clearStoredMidPauseMetadata(stored: StoredConversation): void {
  clearStoredMidPauseMetadataImpl(stored);
}

export function clearStoredCheckpoint(stored: StoredConversation, clearBlobStore = false): void {
  stored.checkpoint = null;
  delete stored.checkpointSource;
  delete stored.checkpointTurnCount;
  delete stored.checkpointHistoryFingerprint;
  clearStoredMidPauseMetadata(stored);
  if (clearBlobStore) stored.blobStore.clear();
}

export function discardStaleCheckpointIfNeeded(
  stored: StoredConversation,
  turns: ParsedTurn[],
  requestId: string,
  convKey: string,
): void {
  // Tier 2 extends staleness validation to metadata-only mid-pause snapshots.
  if (!stored.checkpoint) return;

  const currentTurnCount = turns.length;
  const currentHistoryFingerprint = fingerprintCompletedTurns(turns);
  const storedCheckpointTurnCount = stored.checkpointTurnCount;
  const storedCheckpointHistoryFingerprint = stored.checkpointHistoryFingerprint;
  const reason =
    storedCheckpointTurnCount === undefined || !storedCheckpointHistoryFingerprint
      ? "missing_checkpoint_metadata"
      : storedCheckpointTurnCount !== currentTurnCount
        ? "completed_turn_count_mismatch"
        : storedCheckpointHistoryFingerprint !== currentHistoryFingerprint
          ? "completed_history_fingerprint_mismatch"
          : undefined;

  if (!reason) return;

  debugLog("chat.discard_checkpoint", {
    requestId,
    convKey,
    reason,
    storedCheckpointTurnCount,
    currentTurnCount,
    storedCheckpointHistoryFingerprint,
    currentHistoryFingerprint,
  });
  clearStoredCheckpoint(stored, true);
}

export function trimBlobStore(
  store: Map<string, Uint8Array>,
  maxBytes = MAX_CONVERSATION_BLOB_BYTES,
): { removed: number; totalBytes: number } {
  let totalBytes = 0;
  for (const value of store.values()) totalBytes += value.byteLength;
  if (totalBytes <= maxBytes) return { removed: 0, totalBytes };

  let removed = 0;
  // Map iteration order is insertion order — drop oldest blobs first.
  for (const key of store.keys()) {
    if (totalBytes <= maxBytes) break;
    const value = store.get(key);
    if (!value) continue;
    totalBytes -= value.byteLength;
    store.delete(key);
    removed += 1;
  }
  return { removed, totalBytes };
}

export function mergeBlobStore(
  stored: StoredConversation,
  blobStore: Map<string, Uint8Array>,
): void {
  for (const [k, v] of blobStore) stored.blobStore.set(k, v);
  const trimmed = trimBlobStore(stored.blobStore);
  if (trimmed.removed > 0) {
    debugLog("conversation.blob_store_trimmed", {
      removed: trimmed.removed,
      totalBytes: trimmed.totalBytes,
      maxBytes: MAX_CONVERSATION_BLOB_BYTES,
    });
  }
  stored.lastAccessMs = Date.now();
}

export function commitStoredCheckpoint(
  stored: StoredConversation,
  checkpointBytes: Uint8Array,
  blobStore: Map<string, Uint8Array>,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
): void {
  const completedHistory = [...completedTurns, currentTurn];
  mergeBlobStore(stored, blobStore);
  stored.checkpoint = checkpointBytes;
  stored.checkpointSource = "upstream";
  stored.checkpointTurnCount = completedHistory.length;
  stored.checkpointHistoryFingerprint = fingerprintCompletedTurns(completedHistory);
  clearStoredMidPauseMetadata(stored);
}

export function persistAbortedConversationState(
  convKey: string,
  latestCheckpoint: Uint8Array | null,
  blobStore: Map<string, Uint8Array>,
  completedTurns: ParsedTurn[],
  currentTurn: ParsedTurn,
): void {
  const stored = conversationStates.get(convKey);
  if (!stored) return;

  // Pi records the partial assistant response on an aborted stream. Keep Cursor's
  // matching checkpoint as well, so the next turn can continue the same native
  // conversation instead of rebuilding from a potentially truncated transcript.
  if (latestCheckpoint) {
    commitStoredCheckpoint(stored, latestCheckpoint, blobStore, completedTurns, currentTurn);
  } else {
    // Blob ids referenced by the retained Pi history must outlive the cancelled
    // bridge even when Cursor has not emitted a checkpoint yet.
    mergeBlobStore(stored, blobStore);
  }

  debugLog("native.stream.abort_state_saved", {
    convKey,
    hasCheckpoint: !!latestCheckpoint,
    completedTurnCount: completedTurns.length,
    currentTurn,
  });
}

export function commitStoredCheckpointMidPause(
  stored: StoredConversation,
  checkpointBytes: Uint8Array | null,
  blobStore: Map<string, Uint8Array>,
  completedTurns: ParsedTurn[],
  pendingToolCalls: Array<{ toolCallId: string; toolName: string }>,
): void {
  mergeBlobStore(stored, blobStore);
  const completedHistoryFingerprint = fingerprintCompletedTurns(completedTurns);
  if (checkpointBytes) {
    stored.checkpoint = checkpointBytes;
    stored.checkpointSource = "upstream";
    stored.checkpointTurnCount = completedTurns.length;
    stored.checkpointHistoryFingerprint = completedHistoryFingerprint;
  } else {
    // Metadata-only snapshots intentionally discard any older upstream checkpoint so later
    // recovery code cannot accidentally treat stale bytes as authoritative for this pause.
    stored.checkpoint = null;
    stored.checkpointSource = "absent";
    delete stored.checkpointTurnCount;
    delete stored.checkpointHistoryFingerprint;
  }
  stored.midPausePendingToolCalls = pendingToolCalls.map((c) => ({
    toolCallId: c.toolCallId,
    toolName: c.toolName,
  }));
  stored.midPauseTurnCount = completedTurns.length;
  stored.midPauseHistoryFingerprint = completedHistoryFingerprint;
  stored.midPauseRecordedAtMs = Date.now();
}

export interface HandleBridgeCloseMidPauseInput {
  stored: StoredConversation | undefined;
  latestCheckpoint: Uint8Array | null;
  blobStore: Map<string, Uint8Array>;
  completedTurns: ParsedTurn[];
  pendingExecs: Array<{ toolCallId: string; toolName: string }>;
}

export function handleBridgeCloseMidPause(input: HandleBridgeCloseMidPauseInput): {
  committed: boolean;
} {
  if (!input.stored) return { committed: false };
  commitStoredCheckpointMidPause(
    input.stored,
    input.latestCheckpoint,
    input.blobStore,
    input.completedTurns,
    input.pendingExecs,
  );
  return { committed: true };
}

export function deriveRequestLockKey(body: ChatCompletionRequest): string {
  const sessionId = derivePiSessionId(body);
  if (sessionId) return `session:${sessionId}`;
  return `anonymous:${deriveConversationKey(body.messages)}`;
}

export async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => current);
  sessionLocks.set(key, chained);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(key) === chained) sessionLocks.delete(key);
  }
}

export function derivePiSessionId(
  body: Pick<ChatCompletionRequest, "pi_session_id" | "user">,
): string | undefined {
  const raw = body.pi_session_id ?? body.user;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

export function deriveBridgeKeyFromSessionId(sessionId: string): string {
  return createHash("sha256").update(`bridge:${sessionId}`).digest("hex").slice(0, 16);
}

export function deriveConversationKeyFromSessionId(sessionId: string): string {
  return createHash("sha256").update(`conv:${sessionId}`).digest("hex").slice(0, 16);
}

export function deriveBridgeKey(messages: OpenAIMessage[], sessionId?: string): string {
  if (sessionId) return deriveBridgeKeyFromSessionId(sessionId);
  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  return createHash("sha256")
    .update(`bridge:${firstUserText.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 16);
}

export function deriveConversationKey(messages: OpenAIMessage[], sessionId?: string): string {
  if (sessionId) return deriveConversationKeyFromSessionId(sessionId);
  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  return createHash("sha256")
    .update(`conv:${firstUserText.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 16);
}

export function cleanupSessionState(sessionId?: string): void {
  if (!sessionId) return;
  const bridgeKey = deriveBridgeKeyFromSessionId(sessionId);
  const convKey = deriveConversationKeyFromSessionId(sessionId);
  const active = activeBridges.get(bridgeKey);
  debugLog("session.cleanup", {
    sessionId,
    bridgeKey,
    convKey,
    hasActiveBridge: !!active,
    hadConversation: conversationStates.has(convKey),
  });
  if (active) cleanupBridge(active.bridge, active.heartbeatTimer, bridgeKey);
  conversationStates.delete(convKey);
}

export function deterministicConversationId(convKey: string): string {
  const hex = createHash("sha256").update(`cursor-conv-id:${convKey}`).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${(0x8 | (parseInt(hex[16], 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
