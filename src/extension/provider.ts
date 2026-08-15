/**
 * Provider and OAuth registration for Cursor in Pi AI / Coding Agent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { CursorParameterizedModel } from "../client/cursor-wire.js";
import type { CursorModel } from "../stream/model-discovery.js";
import { augmentCursorModels, FALLBACK_MODELS } from "../models/parameterized.js";
import {
  buildNoReasoningEffortLookup,
  buildRawModelLookup,
  modelConfig,
  processModels,
  type CursorModelRouting,
  type ProcessedModel,
} from "../models/processing.js";
import {
  createCursorNativeStream,
  discoverCursorCatalog,
  readCachedCatalog,
  type CursorCatalog,
} from "../stream/native-core.js";
import { getCursorAgentUrl } from "../stream/config.js";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  pollCursorAuth,
  refreshCursorToken,
} from "../auth/oauth.js";
import { setLastAvailableModels, setLastTokenSource } from "../diagnostics/diagnostics.js";
import { debugExtensionLog } from "./debug-hooks.js";
import { getStartupCursorAccessToken } from "./auth.js";
import { ProviderConstant, CredentialSource } from "../types/enums.js";

export const STARTUP_CATALOG_FRESH_MS = 6 * 60 * 60 * 1000;
export const BACKGROUND_CATALOG_REFRESH_TIMEOUT_MS = 20_000;

export interface ProviderRegistrationContext {
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string>;
  setCurrentToken: (token: string, source: CredentialSource) => void;
  onRegisteredModelsUpdated: (models: ProcessedModel[]) => void;
}

export function loadStartupCatalog(): CursorCatalog {
  if (!process.env.PI_OFFLINE) {
    const cached = readCachedCatalog();
    if (cached) {
      debugExtensionLog("model_discovery.startup.cached", {
        rawCount: cached.rawModels.length,
        parameterizedCount: cached.parameterizedModels.length,
        ageMs: Date.now() - cached.savedAt,
      });
      return {
        rawModels: cached.rawModels.length > 0 ? cached.rawModels : FALLBACK_MODELS,
        parameterizedModels: cached.parameterizedModels,
      };
    }
  }
  return { rawModels: FALLBACK_MODELS, parameterizedModels: [] };
}

export async function refreshCatalogFromNetwork(
  onTokenDiscovered?: (token: string, source: CredentialSource) => void,
  options?: { signal?: AbortSignal },
): Promise<CursorCatalog | undefined> {
  if (process.env.PI_OFFLINE) return undefined;

  let token: { accessToken: string; source: CredentialSource } | undefined;
  try {
    token = await getStartupCursorAccessToken();
  } catch (err) {
    debugExtensionLog("model_discovery.refresh.token_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (!token) {
    debugExtensionLog("model_discovery.refresh.skipped", { reason: "no_cursor_oauth_token" });
    return undefined;
  }

  onTokenDiscovered?.(token.accessToken, token.source);
  setLastTokenSource(token.source);

  try {
    const catalog = await discoverCursorCatalog(token.accessToken, { signal: options?.signal });
    debugExtensionLog("model_discovery.refresh", {
      tokenSource: token.source,
      discoveredCount: catalog.rawModels.length,
      parameterizedCount: catalog.parameterizedModels.length,
    });
    if (catalog.rawModels.length === 0 && catalog.parameterizedModels.length === 0) {
      return undefined;
    }
    return {
      rawModels: catalog.rawModels.length > 0 ? catalog.rawModels : FALLBACK_MODELS,
      parameterizedModels: catalog.parameterizedModels,
    };
  } catch (err) {
    debugExtensionLog("model_discovery.refresh.failed", {
      tokenSource: token.source,
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export interface ProviderManager {
  registerModels: (
    rawModels: CursorModel[],
    parameterizedModels?: CursorParameterizedModel[],
  ) => ProcessedModel[];
  getLastRegisteredModels: () => ProcessedModel[];
}

export function createProviderManager(
  pi: ExtensionAPI,
  context: ProviderRegistrationContext,
): ProviderManager {
  let noReasoningEffortByModelId = new Map<string, string>();
  let rawModelByEffortByModelId = new Map<string, Record<string, CursorModelRouting>>();
  let lastRegisteredModels: ProcessedModel[] = [];
  let catalogRefreshInFlight: Promise<void> | undefined;

  const skipDedup = Boolean(process.env.PI_CURSOR_RAW_MODELS);

  function applyModels(
    rawModels: CursorModel[],
    parameterizedModels: CursorParameterizedModel[] = [],
  ): ProcessedModel[] {
    const augmentedModels = augmentCursorModels(rawModels, parameterizedModels);
    const processed = skipDedup
      ? augmentedModels.map((m) => ({ ...m, supportsEffort: false }) as ProcessedModel)
      : processModels(augmentedModels);
    lastRegisteredModels = processed;
    context.onRegisteredModelsUpdated(processed);
    setLastAvailableModels(
      processed
        .map((m) => m.id)
        .slice(0, 24)
        .join(","),
    );
    noReasoningEffortByModelId = buildNoReasoningEffortLookup(processed);
    rawModelByEffortByModelId = buildRawModelLookup(processed);
    return processed;
  }

  function scheduleCatalogRefresh(): void {
    if (catalogRefreshInFlight || process.env.PI_OFFLINE) return;
    const signal = AbortSignal.timeout(BACKGROUND_CATALOG_REFRESH_TIMEOUT_MS);
    catalogRefreshInFlight = refreshCatalogFromNetwork(context.setCurrentToken, { signal })
      .then((catalog) => {
        if (!catalog) return;
        register(catalog.rawModels, catalog.parameterizedModels);
      })
      .catch((err) => {
        debugExtensionLog("model_discovery.background.failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        catalogRefreshInFlight = undefined;
      });
  }

  function register(
    rawModels: CursorModel[],
    parameterizedModels: CursorParameterizedModel[] = [],
  ): ProcessedModel[] {
    const processed = applyModels(rawModels, parameterizedModels);

    const streamSimple = createCursorNativeStream({
      getAccessToken: context.getAccessToken,
      getNoReasoningEffortByModelId: () => noReasoningEffortByModelId,
      getRawModelRoutingByModelId: () => rawModelByEffortByModelId,
    });

    registerApiProvider(
      {
        api: ProviderConstant.NativeApi,
        stream: streamSimple,
        streamSimple,
      },
      ProviderConstant.Source,
    );

    pi.registerProvider(ProviderConstant.ProviderId, {
      baseUrl: getCursorAgentUrl(),
      api: ProviderConstant.NativeApi,
      streamSimple,
      models: processed.map(modelConfig),

      async refreshModels(refreshContext: {
        force?: boolean;
        allowNetwork?: boolean;
        signal?: AbortSignal;
      }) {
        if (!refreshContext.allowNetwork || refreshContext.signal?.aborted) {
          return lastRegisteredModels.map(modelConfig);
        }
        if (!refreshContext.force) {
          const cached = readCachedCatalog();
          if (!cached || Date.now() - cached.savedAt > STARTUP_CATALOG_FRESH_MS) {
            scheduleCatalogRefresh();
          }
          return lastRegisteredModels.map(modelConfig);
        }
        const catalog = await refreshCatalogFromNetwork(context.setCurrentToken, {
          signal: refreshContext.signal,
        });
        if (!catalog) return lastRegisteredModels.map(modelConfig);
        return applyModels(catalog.rawModels, catalog.parameterizedModels).map(modelConfig);
      },

      oauth: {
        name: "Cursor",

        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
          callbacks.onAuth({ url: loginUrl });
          const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);
          context.setCurrentToken(accessToken, CredentialSource.PiOAuth);

          const catalog = await discoverCursorCatalog(accessToken);
          if (catalog.rawModels.length > 0 || catalog.parameterizedModels.length > 0) {
            register(
              catalog.rawModels.length > 0 ? catalog.rawModels : FALLBACK_MODELS,
              catalog.parameterizedModels,
            );
          }

          return {
            refresh: refreshToken,
            access: accessToken,
            expires: getTokenExpiry(accessToken),
          };
        },

        async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
          const refreshed = await refreshCursorToken(credentials.refresh);
          context.setCurrentToken(refreshed.access, CredentialSource.PiOAuthRefresh);

          const catalog = await discoverCursorCatalog(refreshed.access);
          if (catalog.rawModels.length > 0 || catalog.parameterizedModels.length > 0) {
            register(
              catalog.rawModels.length > 0 ? catalog.rawModels : FALLBACK_MODELS,
              catalog.parameterizedModels,
            );
          }

          return refreshed as OAuthCredentials;
        },

        getApiKey(credentials: OAuthCredentials): string {
          context.setCurrentToken(credentials.access, CredentialSource.PiOAuth);
          return ProviderConstant.NativeApi;
        },
      },
    });

    return processed;
  }

  return {
    registerModels: register,
    getLastRegisteredModels: () => lastRegisteredModels,
  };
}
