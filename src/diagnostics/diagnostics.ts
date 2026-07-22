import { AsyncLocalStorage } from "node:async_hooks";
import { redactSecrets } from "../utils/security.js";

export type DiagnosticsSnapshot = {
  status?: number;
  endpoint?: string;
  error?: string;
  projectId?: string;
  resolvedRuntimeModel?: string;
  availableModels?: string;
  matchedModelDebug?: string;
  lastRpc?: string;
};

const storage = new AsyncLocalStorage<DiagnosticsSnapshot>();
let lastSnapshot: DiagnosticsSnapshot = {};

function currentBag(): DiagnosticsSnapshot {
  return storage.getStore() ?? lastSnapshot;
}

export async function runWithDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
  const bag: DiagnosticsSnapshot = {};
  return storage.run(bag, async () => {
    try {
      return await fn();
    } finally {
      lastSnapshot = { ...bag };
    }
  });
}

export function getLastDiagnostics(): Readonly<DiagnosticsSnapshot> {
  return lastSnapshot;
}

export function setLastStatus(status: number | undefined): void {
  currentBag().status = status;
}
export function setLastEndpoint(endpoint: string | undefined): void {
  currentBag().endpoint = endpoint;
}
export function setLastError(error: string | undefined): void {
  currentBag().error = error === undefined ? undefined : redactSecrets(error).slice(0, 800);
}
export function setLastResolvedRuntimeModel(model: string | undefined): void {
  currentBag().resolvedRuntimeModel = model;
}
export function setLastAvailableModels(models: string | undefined): void {
  currentBag().availableModels = models;
}
export function setLastRpc(rpc: string | undefined): void {
  currentBag().lastRpc = rpc;
}
export function setLastMatchedModelDebug(debug: string | undefined): void {
  currentBag().matchedModelDebug =
    debug === undefined ? undefined : redactSecrets(debug).slice(0, 1200);
}

export function resetDiagnosticsForTests(): void {
  lastSnapshot = {};
}
