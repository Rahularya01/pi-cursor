/**
 * Command registrations: /cursor.models, /cursor.usage, /cursor.doctor.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getLastDiagnostics } from "../diagnostics/diagnostics.js";
import { formatDriftSummary, getDriftSignals, hasStrandingDrift } from "../stream/drift.js";
import { readCachedCatalog } from "../stream/model-cache.js";
import { getCacheDir } from "../utils/cache-dir.js";
import { getCursorAgentUrl, getCursorClientVersion } from "../stream/config.js";
import { resolveSystemCredentialPolicy } from "../auth/consent.js";
import { getLifecycleLogPath } from "../stream/debug-log.js";
import { redactSecrets } from "../utils/security.js";
import { supportsInProcessH2 } from "../client/h2-unary.js";
import { formatCursorUsage, getCursorUsageSummary } from "../usage.js";
import { ProviderConstant, type CredentialSource } from "../types/enums.js";
import type { ProcessedModel } from "../models/processing.js";

export interface CursorCommandOptions {
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  getLastRegisteredModels: () => ProcessedModel[];
  getCurrentTokenSource: () => CredentialSource;
}

export function registerCursorCommands(pi: ExtensionAPI, options: CursorCommandOptions): void {
  pi.registerCommand("cursor.models", {
    description: "List Cursor runtime models registered by this provider",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const all = /\ball\b/i.test(args || "");
      const registered = options.getLastRegisteredModels();
      const rows = all ? registered : registered.filter((m) => !/tab_|chat_/i.test(m.id));
      const lines = [
        `Cursor models (${rows.length}${all ? " all" : ""})`,
        `endpoint=${getCursorAgentUrl()}`,
        "",
      ];
      const maxId = Math.max(8, ...rows.map((m) => m.id.length));
      for (const m of rows) {
        const processed = m as ProcessedModel;
        const levels = Object.entries(processed.effortMap ?? {})
          .filter(([, cursorEffort]) => typeof cursorEffort === "string")
          .map(([level]) => level)
          .join("/");
        const flags = [
          processed.supportsEffort ? "thinking" : "",
          levels ? `levels=${levels}` : "",
          m.supportsImages ? "images" : "",
        ]
          .filter(Boolean)
          .join(",");
        lines.push(
          `${m.id.padEnd(maxId)}  ctx ${String(m.contextWindow ?? "?").padStart(7)}  ${m.name || ""}${flags ? `  [${flags}]` : ""}`,
        );
      }
      if (!rows.length) lines.push("No models registered. Run /login cursor first.");
      const text = lines.join("\n");
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      console.log(text);
    },
  });

  pi.registerCommand("cursor.usage", {
    description: "Show Cursor plan quota and on-demand spend",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      try {
        const text = formatCursorUsage(await getCursorUsageSummary(options.getAccessToken));
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        console.log(text);
      } catch (error) {
        const text = `Cursor usage unavailable: ${redactSecrets(
          error instanceof Error ? error.message : String(error),
        )}`;
        if (ctx.hasUI) ctx.ui.notify(text, "error");
        console.error(text);
      }
    },
  });

  pi.registerCommand("cursor.doctor", {
    description: "Show sanitized Cursor provider diagnostics",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const d = getLastDiagnostics();
      const driftSignals = getDriftSignals();
      const cachedCatalog = readCachedCatalog();
      const registered = options.getLastRegisteredModels();
      const currentTokenSource = options.getCurrentTokenSource();

      const lines = [
        `provider=${ProviderConstant.ProviderId}`,
        `agentUrl=${getCursorAgentUrl()}`,
        `clientVersion=${d.clientVersion || getCursorClientVersion()}`,
        `tokenSource=${d.tokenSource || currentTokenSource || "none"}`,
        `systemCredentials=${d.systemCredentials || resolveSystemCredentialPolicy()}`,
        `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
        `availableModels=${d.availableModels || registered.length || "none"}`,
        `catalogCache=${
          cachedCatalog
            ? `${cachedCatalog.rawModels.length}+${cachedCatalog.parameterizedModels.length} models, age ${Math.round(
                (Date.now() - cachedCatalog.savedAt) / 1000,
              )}s`
            : "none(using bundled fallback)"
        }`,
        `catalogCacheDir=${getCacheDir() || "unavailable"}`,
        `matchedModel=${d.matchedModelDebug || "none"}`,
        `lastEndpoint=${d.endpoint || "none"}`,
        `lastStatus=${d.status ?? "none"}`,
        `lastRpc=${d.lastRpc || "none"}`,
        `lastRecoverySkipReason=${d.lastRecoverySkipReason || "none"}`,
        `lastStreamEvent=${d.lastStreamEvent || "none"}`,
        `lastRequestSize=${d.lastRequestSize || "none"}`,
        `lastDriftSignal=${d.lastDriftSignal || "none"}`,
        `wireDrift=${formatDriftSummary() || "none"}`,
        `wireDriftStranding=${hasStrandingDrift() ? "yes" : "no"}`,
        `lastIdleTimeoutAt=${d.lastIdleTimeoutAt || "none"}`,
        `lastIdleTimeoutMs=${d.lastIdleTimeoutMs ?? "none"}`,
        `lastIdleAttempt=${d.lastIdleAttempt ?? "none"}`,
        `streamIdleTimeoutMs=${process.env.PI_CURSOR_STREAM_IDLE_TIMEOUT_MS || "0(disabled)"}`,
        `resumeIdleTimeoutMs=${process.env.PI_CURSOR_RESUME_IDLE_TIMEOUT_MS || "0(disabled)"}`,
        `streamIdleMaxRetries=${process.env.PI_CURSOR_STREAM_IDLE_MAX_RETRIES || "0(disabled)"}`,
        `h2IdleTimeoutMs=${process.env.PI_CURSOR_H2_IDLE_TIMEOUT_MS || "0(disabled)"}`,
        `lifecycleLog=${getLifecycleLogPath()}`,
        `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
        "transport=native-streamSimple",
        `unaryTransport=${supportsInProcessH2() ? "in-process-h2" : "bridge-subprocess"}`,
        "runtimeCli=not-used",
        "proxyPath=removed",
        "commands=/cursor.models /cursor.usage /cursor.doctor",
        "hint=On stalls check lifecycle log + lastStreamEvent; InteractionQuery hangs fixed in 1.2.2; re-login or PI_CURSOR_CLIENT_VERSION on wire errors",
      ];
      if (driftSignals.length > 0) {
        lines.push("--- wire drift detail ---");
        for (const s of driftSignals) {
          lines.push(`  ${s.kind}: ${s.detail} (x${s.count}, first ${s.firstSeenIso})`);
        }
        lines.push("  Cursor's agent schema may have moved. See proto/README.md to regenerate,");
        lines.push("  or pin PI_CURSOR_CLIENT_VERSION to a build that matches.");
      }
      const text = lines.join("\n");
      if (ctx.hasUI) ctx.ui.notify(`Cursor doctor\n${text}`, "info");
      console.log(text);
    },
  });
}
