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
  tokenSource?: string;
  clientVersion?: string;
  lastRecoverySkipReason?: string;
  systemCredentials?: string;
  /** ISO timestamp of the most recent stream idle timeout. */
  lastIdleTimeoutAt?: string;
  /** Configured idle timeout (ms) that fired. */
  lastIdleTimeoutMs?: number;
  /** Attempt number when the idle timeout fired. */
  lastIdleAttempt?: number;
  /** Short event name for the latest stream lifecycle signal. */
  lastStreamEvent?: string;
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
export function setLastTokenSource(source: string | undefined): void {
  currentBag().tokenSource = source;
}
export function setLastClientVersion(version: string | undefined): void {
  currentBag().clientVersion = version;
}
export function setLastRecoverySkipReason(reason: string | undefined): void {
  currentBag().lastRecoverySkipReason =
    reason === undefined ? undefined : redactSecrets(reason).slice(0, 200);
}
export function setSystemCredentialsPolicy(policy: string | undefined): void {
  currentBag().systemCredentials = policy;
}
export function setLastStreamEvent(event: string | undefined): void {
  currentBag().lastStreamEvent =
    event === undefined ? undefined : redactSecrets(event).slice(0, 200);
}
export function setLastIdleTimeout(info: {
  timeoutMs: number;
  attempt: number;
  event?: string;
}): void {
  const bag = currentBag();
  bag.lastIdleTimeoutAt = new Date().toISOString();
  bag.lastIdleTimeoutMs = info.timeoutMs;
  bag.lastIdleAttempt = info.attempt;
  if (info.event) {
    bag.lastStreamEvent = redactSecrets(info.event).slice(0, 200);
  }
}

export function resetDiagnosticsForTests(): void {
  lastSnapshot = {};
}
