/**
 * Live model discovery over Connect unary RPCs.
 *
 * Cursor exposes the account's usable models through `GetUsableModels` plus a
 * parameterized-metadata variant. Both go over the same child-process bridge as
 * streaming, just without the bidirectional half, so responses arrive as a
 * single length-prefixed Connect frame that `decodeConnectUnaryBody` unwraps.
 *
 * Results are memoized per access token: a token hash keys the cache so a
 * re-login or account switch invalidates it without a manual reset.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";

import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from "../proto/agent_pb.js";
import {
  decodeAvailableModelsResponse,
  encodeAvailableModelsRequest,
  type CursorModelParameter,
  type CursorParameterizedModel,
} from "../client/cursor-wire.js";
import {
  callUnaryOverH2,
  MAX_UNARY_RESPONSE_BYTES,
  supportsInProcessH2,
} from "../client/h2-unary.js";
import { getBridgeFactory } from "./bridge-session.js";
import { getCursorAgentUrl } from "./config.js";
import { writeCachedCatalog } from "./model-cache.js";

export async function callCursorUnaryRpc(options: {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  // Prefer the in-process HTTP/2 client: it skips a child-process spawn, a
  // second TLS handshake and the bridge's exit flush. Any transport failure
  // falls through to the bridge, which remains the only path on Bun.
  if (supportsInProcessH2()) {
    try {
      const result = await callUnaryOverH2({
        accessToken: options.accessToken,
        rpcPath: options.rpcPath,
        requestBody: options.requestBody,
        url: options.url,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      const ok = result.status >= 200 && result.status < 300;
      return { body: result.body, exitCode: ok ? 0 : 1, timedOut: false };
    } catch {
      if (options.signal?.aborted) return { body: new Uint8Array(0), exitCode: 1, timedOut: true };
      // Fall back to the child-process bridge below.
    }
  }

  const bridge = getBridgeFactory()({
    accessToken: options.accessToken,
    rpcPath: options.rpcPath,
    url: options.url,
    unary: true,
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let responseBytes = 0;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      resolve({ body: Buffer.concat(chunks), exitCode, timedOut });
    };
    const stopBridge = () => {
      try {
        bridge.proc.kill();
      } catch {
        // The bridge may have exited between the event and this cleanup.
      }
    };
    const abort = () => {
      timedOut = true;
      stopBridge();
      finish(1);
    };
    const timeoutMs = options.timeoutMs ?? 5_000;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stopBridge();
            finish(1);
          }, timeoutMs)
        : undefined;

    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });

    bridge.onData((chunk) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_UNARY_RESPONSE_BYTES) {
        stopBridge();
        finish(1);
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    bridge.onClose((exitCode) => {
      finish(exitCode);
    });

    try {
      bridge.write(options.requestBody);
      bridge.end();
    } catch {
      stopBridge();
      finish(1);
    }
  });
}

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  requestedModelId?: string;
  parameters?: CursorModelParameter[];
  requiresMaxMode?: boolean;
  requestedMaxMode?: boolean;
  supportsImages?: boolean;
}

let cachedModels: { tokenHash: string; models: CursorModel[]; expiresAt: number } | null = null;

let cachedParameterizedModels: {
  tokenHash: string;
  models: CursorParameterizedModel[];
  expiresAt: number;
} | null = null;

/** Model list cache TTL: 5 minutes. Re-fetches on token change or TTL expiry. */
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

function tokenCacheHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export async function getCursorModels(
  apiKey: string,
  options?: { signal?: AbortSignal },
): Promise<CursorModel[]> {
  const tokenHash = tokenCacheHash(apiKey);
  if (cachedModels?.tokenHash === tokenHash && Date.now() < cachedModels.expiresAt)
    return cachedModels.models;
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const requestBody = toBinary(GetUsableModelsRequestSchema, requestPayload);
    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: "/agent.v1.AgentService/GetUsableModels",
      requestBody,
      url: getCursorAgentUrl(),
      signal: options?.signal,
    });
    if (!response.timedOut && response.exitCode === 0 && response.body.length > 0) {
      let decoded: any = null;
      try {
        decoded = fromBinary(GetUsableModelsResponseSchema, response.body);
      } catch {
        // Try Connect framing after plain protobuf decode fails.
        const body = decodeConnectUnaryBody(response.body);
        if (body) {
          try {
            decoded = fromBinary(GetUsableModelsResponseSchema, body);
          } catch {
            decoded = null;
          }
        }
      }
      if (decoded?.models?.length) {
        const models = normalizeCursorModels(decoded.models);
        if (models.length > 0) {
          cachedModels = { tokenHash, models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
          return models;
        }
      }
    }
  } catch (err) {
    console.error(
      "[cursor-provider] Model discovery failed:",
      err instanceof Error ? err.message : err,
    );
  }
  console.warn("[cursor-provider] Model discovery returned no models");
  return [];
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;
    if ((flags & 0b0000_0001) !== 0) return null;
    if ((flags & 0b0000_0010) === 0) return payload.subarray(offset + 5, frameEnd);
    offset = frameEnd;
  }
  return null;
}

export async function getCursorParameterizedModels(
  apiKey: string,
  options?: { signal?: AbortSignal },
): Promise<CursorParameterizedModel[]> {
  const tokenHash = tokenCacheHash(apiKey);
  if (
    cachedParameterizedModels?.tokenHash === tokenHash &&
    Date.now() < cachedParameterizedModels.expiresAt
  )
    return cachedParameterizedModels.models;
  try {
    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: "/aiserver.v1.AiService/AvailableModels",
      requestBody: encodeAvailableModelsRequest(),
      signal: options?.signal,
    });
    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) return [];
    const body = decodeConnectUnaryBody(response.body) ?? response.body;
    const models = decodeAvailableModelsResponse(body);
    cachedParameterizedModels = { tokenHash, models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
    return models;
  } catch (err) {
    console.error(
      "[cursor-provider] Parameterized model discovery failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

export interface CursorCatalog {
  rawModels: CursorModel[];
  parameterizedModels: CursorParameterizedModel[];
}

/**
 * Run both discovery RPCs and persist the result for the next process.
 *
 * This is the only path that writes the cross-process catalog cache, so a
 * partial failure (one RPC empty) still records whatever did come back rather
 * than leaving the next launch on the bundled fallback list.
 */
export async function discoverCursorCatalog(
  apiKey: string,
  options?: { signal?: AbortSignal },
): Promise<CursorCatalog> {
  const [rawModels, parameterizedModels] = await Promise.all([
    getCursorModels(apiKey, options),
    getCursorParameterizedModels(apiKey, options),
  ]);
  if (rawModels.length > 0 || parameterizedModels.length > 0) {
    writeCachedCatalog({ tokenHash: tokenCacheHash(apiKey), rawModels, parameterizedModels });
  }
  return { rawModels, parameterizedModels };
}

export function inferCursorContextWindow(id: string, name: string): number {
  const text = `${id} ${name}`.toLowerCase();
  if (/\b1\s*m\b|(?:^|-)1m(?:-|$)/.test(text)) return 1_000_000;
  if (/\b272\s*k\b|(?:^|-)272k(?:-|$)/.test(text)) return 272_000;
  return 200_000;
}

function normalizeCursorModels(models: readonly unknown[]): CursorModel[] {
  const byId = new Map<string, CursorModel>();
  for (const model of models) {
    const m = model as any;
    const id = m?.modelId?.trim?.();
    if (!id) continue;
    const name = m.displayName || m.displayNameShort || m.displayModelId || id;
    byId.set(id, {
      id,
      name,
      reasoning: Boolean(m.thinkingDetails),
      contextWindow: inferCursorContextWindow(id, name),
      maxTokens: 64_000,
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
