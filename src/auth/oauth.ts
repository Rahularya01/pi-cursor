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
}

export interface CursorAuthLoginCallbacks {
  onAuth(payload: { url: string }): void | Promise<void>;
}

export function createCursorAuthClient(deps: CursorAuthClientDependencies = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const sleepImpl =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const generatePkceImpl: () => Promise<{ verifier: string; challenge: string; uuid?: string }> =
    deps.generatePkce ?? generatePKCE;
  const randomUUIDImpl = deps.randomUUID ?? (() => crypto.randomUUID());

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
  ): Promise<{ accessToken: string; refreshToken: string }> {
    let delay = POLL_BASE_DELAY;
    let consecutiveErrors = 0;

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleepImpl(delay);

      try {
        const response = await fetchImpl(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`);

        if (response.status === 404) {
          consecutiveErrors = 0;
          delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
          continue;
        }

        if (response.ok) {
          const data = (await response.json()) as {
            accessToken: string;
            refreshToken: string;
          };
          return {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
          };
        }

        throw new Error(`Poll failed: ${response.status}`);
      } catch {
        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
          throw new Error("Too many consecutive errors during Cursor auth polling");
        }
      }
    }

    throw new Error("Cursor authentication polling timeout");
  }

  async function refreshToken(refreshToken: string): Promise<CursorCredentials> {
    const response = await fetchImpl(CURSOR_REFRESH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cursor token refresh failed: ${error}`);
    }

    const data = (await response.json()) as {
      accessToken: string;
      refreshToken: string;
    };

    return {
      access: data.accessToken,
      refresh: data.refreshToken || refreshToken,
      expires: getTokenExpiry(data.accessToken),
    };
  }

  async function login(callbacks: CursorAuthLoginCallbacks): Promise<CursorCredentials> {
    const { verifier, uuid, loginUrl } = await generateParams();
    await callbacks.onAuth({ url: loginUrl });
    const { accessToken, refreshToken } = await poll(uuid, verifier);
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
): Promise<{ accessToken: string; refreshToken: string }> {
  return createCursorAuthClient().poll(uuid, verifier);
}

// ── Token refresh ──

export interface CursorCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export async function refreshCursorToken(refreshToken: string): Promise<CursorCredentials> {
  return createCursorAuthClient().refreshToken(refreshToken);
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
