/** Native non-local handlers retained on the open Cursor stream. */
import { create } from "@bufbuild/protobuf";
import {
  DiagnosticsResultSchema,
  DiagnosticsSuccessSchema,
  FetchErrorSchema,
  FetchResultSchema,
  FetchSuccessSchema,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesSuccessSchema,
} from "../proto/agent_pb.js";

const MAX_FETCH_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export type NativeExecFrame = { resultCase: string; value: unknown };
export type NativeExecDispatch =
  { kind: "sync"; frame: NativeExecFrame } | { kind: "async"; run: () => Promise<NativeExecFrame> };

/** Dispatches retained native handlers; local file and shell operations have no executor here. */
export function dispatchNativeExec(
  execCase: string,
  args: Record<string, unknown>,
): NativeExecDispatch | undefined {
  switch (execCase) {
    case "diagnosticsArgs":
      return { kind: "sync", frame: execDiagnostics(args) };
    case "listMcpResourcesExecArgs":
      return {
        kind: "sync",
        frame: {
          resultCase: "listMcpResourcesExecResult",
          value: create(ListMcpResourcesExecResultSchema, {
            result: {
              case: "success",
              value: create(ListMcpResourcesSuccessSchema, { resources: [] }),
            },
          }),
        },
      };
    case "fetchArgs":
      return { kind: "async", run: () => execFetch(args) };
    default:
      return undefined;
  }
}

/** Returns an empty diagnostic result because this provider does not run workspace diagnostics. */
function execDiagnostics(args: Record<string, unknown>): NativeExecFrame {
  const rawPath = typeof args.path === "string" ? args.path : "";
  return {
    resultCase: "diagnosticsResult",
    value: create(DiagnosticsResultSchema, {
      result: {
        case: "success",
        value: create(DiagnosticsSuccessSchema, {
          path: rawPath,
          diagnostics: [],
          totalDiagnostics: 0,
        }),
      },
    }),
  };
}

/** Fetches HTTP(S) content with a timeout and truncates the returned text to the transport limit. */
async function execFetch(args: Record<string, unknown>): Promise<NativeExecFrame> {
  const url = typeof args.url === "string" ? args.url : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fetchError(url, "Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fetchError(url, "Only http and https URLs can be fetched");
  }
  try {
    const response = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const buf = Buffer.from(await response.arrayBuffer());
    const truncated = buf.byteLength > MAX_FETCH_BYTES;
    const content = buf.subarray(0, MAX_FETCH_BYTES).toString("utf8");
    return {
      resultCase: "fetchResult",
      value: create(FetchResultSchema, {
        result: {
          case: "success",
          value: create(FetchSuccessSchema, {
            url,
            content: truncated ? `${content}\n\n[truncated]` : content,
            statusCode: response.status,
            contentType: response.headers.get("content-type") ?? "",
          }),
        },
      }),
    };
  } catch (error) {
    return fetchError(url, error instanceof Error ? error.message : String(error));
  }
}

/** Wraps a fetch failure in the typed result expected by the waiting Cursor request. */
function fetchError(url: string, error: string): NativeExecFrame {
  return {
    resultCase: "fetchResult",
    value: create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url, error }) },
    }),
  };
}
