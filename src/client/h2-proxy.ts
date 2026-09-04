/**
 * HTTP CONNECT tunnel so Cursor's HTTP/2 client can reach the origin through
 * an HTTPS proxy (PI_PROXY_CURSOR, PI_PROXY, or HTTPS_PROXY).
 */
import net from "node:net";
import tls from "node:tls";

const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

export function resolveCursorProxyUrl(): URL | undefined {
  const raw =
    process.env.PI_PROXY_CURSOR?.trim() ||
    process.env.PI_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

export async function connectProxiedSocket(
  proxyUrl: URL,
  targetOrigin: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<tls.TLSSocket> {
  if (options?.signal?.aborted) {
    throw new Error("Proxy tunnel aborted");
  }
  const target = new URL(targetOrigin);
  const targetHost = target.hostname;
  const targetPort = Number(target.port || 443);
  const useProxyTls = proxyUrl.protocol === "https:";
  const proxyPort = Number(proxyUrl.port || (useProxyTls ? 443 : 80));
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;

  return await new Promise<tls.TLSSocket>((resolve, reject) => {
    let settled = false;
    let tunnel: tls.TLSSocket | undefined;
    let header = "";
    const rawSocket: net.Socket = useProxyTls
      ? tls.connect({
          host: proxyUrl.hostname,
          port: proxyPort,
          servername: proxyUrl.hostname,
        })
      : net.connect(proxyPort, proxyUrl.hostname);
    const timer = setTimeout(() => fail(new Error("Proxy CONNECT timed out")), timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rawSocket.destroy();
      tunnel?.destroy();
      reject(error);
    };

    const succeed = (socket: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };

    function onAbort() {
      fail(new Error("Proxy tunnel aborted"));
    }
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const onProxyReady = () => {
      let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
      if (proxyUrl.username || proxyUrl.password) {
        const creds = Buffer.from(
          `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
        ).toString("base64");
        connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
      }
      connectReq += "\r\n";
      rawSocket.write(connectReq);
      rawSocket.on("data", onProxyData);
    };

    const onProxyData = (chunk: Buffer) => {
      header += chunk.toString("utf8");
      const split = header.indexOf("\r\n\r\n");
      if (split < 0) return;
      const statusLine = header.slice(0, header.indexOf("\r\n"));
      if (!/\s200\b/.test(statusLine)) {
        fail(new Error(`Proxy CONNECT failed: ${statusLine.trim()}`));
        return;
      }
      rawSocket.off("data", onProxyData);
      tunnel = tls.connect({
        socket: rawSocket,
        servername: targetHost,
        ALPNProtocols: ["h2"],
      });
      tunnel.once("secureConnect", () => succeed(tunnel!));
      tunnel.once("error", fail);
    };

    rawSocket.once(useProxyTls ? "secureConnect" : "connect", onProxyReady);
    rawSocket.once("error", fail);
  });
}
