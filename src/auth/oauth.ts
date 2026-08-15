/**
 * Cursor OAuth authentication via PKCE.
 *
 * Flow:
 * 1. Generate PKCE verifier + challenge
 * 2. Open browser to cursor.com/loginDeepControl
 * 3. Poll api2.cursor.sh/auth/poll until tokens arrive
 * 4. Refresh via api2.cursor.sh/auth/exchange_user_api_key
 *
 * Based on https://github.com/ephraimduncan/opencode-cursor by Ephraim Duncan.
 */

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
const AUTH_REQUEST_TIMEOUT_MS = 15_000;

function authRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseTokenResponse(
  value: unknown,
  endpoint: string,
): {
  accessToken: string;
  refreshToken?: string;
} {
  if (!value || typeof value !== "object") {
    throw new Error(`${endpoint} returned an invalid token response`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.accessToken !== "string" || !record.accessToken.trim()) {
    throw new Error(`${endpoint} returned no access token`);
  }
  if (record.refreshToken !== undefined && typeof record.refreshToken !== "string") {
    throw new Error(`${endpoint} returned an invalid refresh token`);
  }
  return {
    accessToken: record.accessToken,
    ...(typeof record.refreshToken === "string" ? { refreshToken: record.refreshToken } : {}),
  };
}

// ── PKCE ──

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(96);
  crypto.getRandomValues(verifierBytes);
  const verifier = Buffer.from(verifierBytes).toString("base64url");

  const data = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = Buffer.from(hashBuffer).toString("base64url");

  return { verifier, challenge };
}

// ── Login params ──

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
}

export interface CursorAuthClientDependencies {
  fetch?: typeof fetch;
  generatePkce?: () => Promise<{ verifier: string; challenge: string; uuid?: string }>;
  randomUUID?: () => string;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
}

export interface CursorAuthLoginCallbacks {
  onAuth(payload: { url: string }): void | Promise<void>;
}

export function createCursorAuthClient(deps: CursorAuthClientDependencies = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const requestTimeoutMs = deps.requestTimeoutMs ?? AUTH_REQUEST_TIMEOUT_MS;
  const sleepImpl =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const generatePkceImpl: () => Promise<{ verifier: string; challenge: string; uuid?: string }> =
    deps.generatePkce ?? generatePKCE;
  const randomUUIDImpl = deps.randomUUID ?? (() => crypto.randomUUID());

  async function sleepForPoll(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await sleepImpl(ms);
      return;
    }
    if (signal.aborted) throw new Error("Cursor authentication polling aborted");
    let rejectAbort: ((reason: Error) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort?.(new Error("Cursor authentication polling aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([sleepImpl(ms), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async function generateParams(): Promise<CursorAuthParams> {
    const { verifier, challenge, uuid: injectedUuid } = await generatePkceImpl();
    const uuid = injectedUuid ?? randomUUIDImpl();

    const params = new URLSearchParams({
      challenge,
      uuid,
      mode: "login",
      redirectTarget: "cli",
    });

    const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;
    return { verifier, challenge, uuid, loginUrl };
  }

  async function poll(
    uuid: string,
    verifier: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    let delay = POLL_BASE_DELAY;
    let consecutiveErrors = 0;

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleepForPoll(delay, options?.signal);

      try {
        const response = await fetchImpl(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`, {
          signal: authRequestSignal(options?.signal, requestTimeoutMs),
        });

        if (response.status === 404) {
          consecutiveErrors = 0;
          delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
          continue;
        }

        if (response.ok) {
          const data = parseTokenResponse(await response.json(), "Cursor authentication polling");
          if (!data.refreshToken) {
            throw new Error("Cursor authentication polling returned no refresh token");
          }
          return {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
          };
        }

        throw new Error(`Poll failed: ${response.status}`);
      } catch (error) {
        if (options?.signal?.aborted) {
          throw new Error("Cursor authentication polling aborted", { cause: error });
        }
        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
          throw new Error("Too many consecutive errors during Cursor auth polling", {
            cause: error,
          });
        }
      }
    }

    throw new Error("Cursor authentication polling timeout");
  }

  async function refreshToken(
    refreshToken: string,
    options?: { signal?: AbortSignal },
  ): Promise<CursorCredentials> {
    const response = await fetchImpl(CURSOR_REFRESH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: authRequestSignal(options?.signal, requestTimeoutMs),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cursor token refresh failed: ${error}`);
    }

    const data = parseTokenResponse(await response.json(), "Cursor token refresh");

    return {
      access: data.accessToken,
      refresh: data.refreshToken || refreshToken,
      expires: getTokenExpiry(data.accessToken),
    };
  }

  async function login(
    callbacks: CursorAuthLoginCallbacks,
    options?: { signal?: AbortSignal },
  ): Promise<CursorCredentials> {
    const { verifier, uuid, loginUrl } = await generateParams();
    await callbacks.onAuth({ url: loginUrl });
    const { accessToken, refreshToken } = await poll(uuid, verifier, options);
    return {
      access: accessToken,
      refresh: refreshToken,
      expires: getTokenExpiry(accessToken),
    };
  }

  return {
    generateParams,
    login,
    poll,
    refreshToken,
  };
}

export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
  return createCursorAuthClient().generateParams();
}

// ── Poll for auth completion ──

export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  options?: { signal?: AbortSignal },
): Promise<{ accessToken: string; refreshToken: string }> {
  return createCursorAuthClient().poll(uuid, verifier, options);
}

// ── Token refresh ──

export interface CursorCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export async function refreshCursorToken(
  refreshToken: string,
  options?: { signal?: AbortSignal },
): Promise<CursorCredentials> {
  return createCursorAuthClient().refreshToken(refreshToken, options);
}

// ── JWT expiry extraction ──

export function getCursorAccessTokenFromEnv(): string | undefined {
  const token = process.env.CURSOR_ACCESS_TOKEN?.trim();
  return token || undefined;
}

export function getTokenExpiry(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      return Date.now() + 3600 * 1000;
    }
    const decoded = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (decoded && typeof decoded === "object" && typeof decoded.exp === "number") {
      return decoded.exp * 1000 - 5 * 60 * 1000;
    }
  } catch {}
  return Date.now() + 3600 * 1000;
}
