/**
 * Extension debug logging hooks and image payload extraction.
 */

import { appendFile } from "node:fs";
import { createHash } from "node:crypto";
import { join as pathJoin } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCacheDir } from "../utils/cache-dir.js";
import { cleanupSessionState } from "../stream/session-state.js";

let extensionDebugLogFilePath: string | undefined;

export function isExtensionDebugEnabled(): boolean {
  const raw = process.env.PI_CURSOR_PROVIDER_DEBUG?.trim().toLowerCase();
  return Boolean(raw && raw !== "0" && raw !== "false" && raw !== "off");
}

export function getExtensionDebugLogFilePath(): string {
  if (extensionDebugLogFilePath) return extensionDebugLogFilePath;
  const configured = process.env.PI_CURSOR_PROVIDER_EXTENSION_DEBUG_FILE?.trim();
  if (configured) {
    extensionDebugLogFilePath = configured;
    return extensionDebugLogFilePath;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  extensionDebugLogFilePath = pathJoin(
    getCacheDir() ?? process.cwd(),
    `pi-cursor-provider-extension-debug-${stamp}-${process.pid}.log`,
  );
  return extensionDebugLogFilePath;
}

export function truncateDebugValue(value: string, max = 240): string {
  return value.length > max
    ? `${value.slice(0, max)}…<truncated ${value.length - max} chars>`
    : value;
}

export function summarizeBase64ImageData(data: string): {
  base64Length: number;
  byteLength?: number;
  sha256?: string;
} {
  const summary: { base64Length: number; byteLength?: number; sha256?: string } = {
    base64Length: data.length,
  };
  try {
    const bytes = Buffer.from(data.replace(/\s/g, ""), "base64");
    if (bytes.length > 0) {
      summary.byteLength = bytes.length;
      summary.sha256 = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    }
  } catch {
    // Invalid base64 — keep length-only summary.
  }
  return summary;
}

export function summarizeImageBlock(type: unknown, mimeType: unknown, data: unknown): unknown {
  return {
    type,
    mimeType,
    ...(typeof data === "string"
      ? summarizeBase64ImageData(data)
      : { data: `<redacted base64 ${String(data ?? "").length} chars>` }),
  };
}

export function summarizeDataImageUrl(url: string): unknown {
  const match = url.trim().match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is);
  if (!match) {
    return {
      url: url.startsWith("data:image/")
        ? `<redacted data image ${url.length} chars>`
        : truncateDebugValue(url),
    };
  }
  return {
    mimeType: match[1]?.toLowerCase(),
    ...summarizeBase64ImageData(match[2] ?? ""),
  };
}

export function summarizeContent(content: unknown): unknown {
  if (typeof content === "string") return truncateDebugValue(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const typed = block as Record<string, unknown>;
    switch (typed.type) {
      case "text":
        return { type: "text", text: truncateDebugValue(String(typed.text ?? "")) };
      case "thinking":
        return { type: "thinking", thinking: truncateDebugValue(String(typed.thinking ?? "")) };
      case "toolCall":
        return {
          type: "toolCall",
          id: typed.id,
          name: typed.name,
          arguments: typed.arguments,
        };
      case "image":
        return summarizeImageBlock("image", typed.mimeType, typed.data);
      case "image_url": {
        const url = (typed.image_url as Record<string, unknown> | undefined)?.url;
        const text = typeof url === "string" ? url : "";
        return { type: "image_url", image_url: summarizeDataImageUrl(text) };
      }
      default:
        return typed;
    }
  });
}

export function summarizeMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const typed = message as Record<string, unknown>;
  return {
    role: typed.role,
    stopReason: typed.stopReason,
    toolCallId: typed.toolCallId,
    toolName: typed.toolName,
    isError: typed.isError,
    errorMessage: typed.errorMessage,
    content: summarizeContent(typed.content),
  };
}

export function summarizeBranchTail(
  ctx: {
    sessionManager?: {
      getBranch?: () => unknown[];
      getLeafId?: () => string | null;
      getSessionId?: () => string;
    };
  },
  limit = 6,
): unknown {
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return undefined;
    return {
      sessionId: ctx.sessionManager?.getSessionId?.(),
      leafId: ctx.sessionManager?.getLeafId?.(),
      size: branch.length,
      tail: branch.slice(-limit).map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const typed = entry as Record<string, unknown>;
        return {
          type: typed.type,
          id: typed.id,
          parentId: typed.parentId,
          customType: typed.customType,
          message: summarizeMessage(typed.message),
        };
      }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CursorToolResultImagePayload {
  toolCallId: string;
  images: Array<{ data: string; mimeType: string }>;
}

function payloadToolCallIds(payload: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const typed = message as Record<string, unknown>;
    if (typed.role === "tool" && typeof typed.tool_call_id === "string" && typed.tool_call_id) {
      ids.add(typed.tool_call_id);
    }
  }
  return ids;
}

export function extractToolResultImagePayloads(
  ctx: { sessionManager?: { getBranch?: () => unknown[] } },
  payload: Record<string, unknown>,
): CursorToolResultImagePayload[] {
  const idsInPayload = payloadToolCallIds(payload);
  if (idsInPayload.size === 0) return [];
  const branch = ctx.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return [];

  const byToolCallId = new Map<string, CursorToolResultImagePayload>();
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const message = (entry as Record<string, unknown>).message;
    if (!message || typeof message !== "object") continue;
    const typed = message as Record<string, unknown>;
    const toolCallId = typeof typed.toolCallId === "string" ? typed.toolCallId : "";
    if (typed.role !== "toolResult" || !toolCallId || !idsInPayload.has(toolCallId)) continue;
    const content = Array.isArray(typed.content) ? typed.content : [];
    const images = content.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const image = block as Record<string, unknown>;
      if (
        image.type !== "image" ||
        typeof image.data !== "string" ||
        typeof image.mimeType !== "string"
      ) {
        return [];
      }
      return [{ data: image.data, mimeType: image.mimeType }];
    });
    if (images.length === 0) continue;
    const existing = byToolCallId.get(toolCallId);
    if (existing) {
      existing.images.push(...images);
    } else {
      byToolCallId.set(toolCallId, { toolCallId, images });
    }
  }
  return [...byToolCallId.values()];
}

export function debugExtensionLog(event: string, data?: Record<string, unknown>): void {
  if (!isExtensionDebugEnabled()) return;
  try {
    const payload = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      scope: "extension",
      event,
      ...data,
    });
    appendFile(
      getExtensionDebugLogFilePath(),
      `${payload}\n`,
      { encoding: "utf8", mode: 0o600 },
      () => {},
    );
  } catch {
    // Debug logging must never break extension hooks.
  }
}

export function registerSessionLifecycleCleanup(pi: ExtensionAPI): void {
  const cleanupCurrentSession = (_event: unknown, ctx: ExtensionContext) => {
    debugExtensionLog("session.cleanup_hook", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
    });
    cleanupSessionState(ctx.sessionManager.getSessionId());
  };

  pi.on("session_before_switch", cleanupCurrentSession);
  pi.on("session_before_fork", cleanupCurrentSession);
  pi.on("session_before_tree", cleanupCurrentSession);
  pi.on("session_shutdown", cleanupCurrentSession);
}

export function registerExtensionDebugHooks(pi: ExtensionAPI): void {
  if (!isExtensionDebugEnabled()) return;

  pi.on("message_start", (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.start", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
    });
  });

  pi.on("message_update", (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as {
      message?: unknown;
      assistantMessageEvent?: Record<string, unknown>;
    };
    debugExtensionLog("message.update", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      assistantMessageEvent: typedEvent.assistantMessageEvent
        ? {
            type: typedEvent.assistantMessageEvent.type,
            delta: truncateDebugValue(
              String(
                (typedEvent.assistantMessageEvent as Record<string, unknown>).delta ??
                  (typedEvent.assistantMessageEvent as Record<string, unknown>).content ??
                  "",
              ),
            ),
          }
        : undefined,
      message: summarizeMessage(typedEvent.message),
    });
  });

  pi.on("message_end", (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    debugExtensionLog("message.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      message: summarizeMessage((event as { message?: unknown }).message),
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("context", (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as { messages?: unknown[] };
    debugExtensionLog("context", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      messageCount: Array.isArray(typedEvent.messages) ? typedEvent.messages.length : undefined,
      messages: Array.isArray(typedEvent.messages)
        ? typedEvent.messages.slice(-8).map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  pi.on("turn_end", (event, ctx) => {
    if (ctx.model?.provider !== "cursor") return;
    const typedEvent = event as { turnIndex?: number; message?: unknown; toolResults?: unknown[] };
    debugExtensionLog("turn.end", {
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId?.(),
      model: ctx.model?.id,
      turnIndex: typedEvent.turnIndex,
      message: summarizeMessage(typedEvent.message),
      toolResults: Array.isArray(typedEvent.toolResults)
        ? typedEvent.toolResults.map((message) => summarizeMessage(message))
        : undefined,
      branch: summarizeBranchTail(ctx),
    });
  });

  debugExtensionLog("extension.debug_hooks_registered", {
    logFile: getExtensionDebugLogFilePath(),
  });
}
