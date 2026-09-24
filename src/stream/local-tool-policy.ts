/** Local operations are executed by Pi, never by the provider. */
import type { McpToolDefinition } from "../proto/agent_pb.js";
import { MCP_PROVIDER_IDENTIFIER, cursorMcpToolName } from "./root-prompt.js";

export const MAX_LOCAL_TOOL_REJECTIONS = 8;
export const LOCAL_TOOL_LOOP_ERROR =
  `Cursor repeatedly requested disabled local tools (${MAX_LOCAL_TOOL_REJECTIONS} requests without a Pi tool result). ` +
  "Local operations must use the registered Pi MCP tools. Stopped to avoid an endless retry loop.";

const LOCAL_TOOL_HINTS: Record<string, string[]> = {
  readArgs: ["read", "Read", "bash"],
  lsArgs: ["ls", "LS", "bash"],
  grepArgs: ["grep", "Grep", "bash"],
  writeArgs: ["write", "Write", "edit", "Edit", "bash"],
  deleteArgs: ["bash"],
  shellArgs: ["bash"],
  shellStreamArgs: ["bash"],
  backgroundShellSpawnArgs: ["bash"],
  writeShellStdinArgs: ["bash"],
};

/**
 * Cursor's server-side `GetDynamicTools` catalog does not list the `pi`
 * namespace even though the same request's `mcpTools` make it callable, so
 * models that enumerate tools before acting conclude the Pi tools are
 * unregistered. The policy points them at `CallDynamicTool` instead of
 * relying on discovery, with schemas listed only for registered tools.
 */
const COMMON_SCHEMAS: Record<string, string> = {
  bash: '{"command"}',
  read: '{"path","offset","limit"}',
  write: '{"path","content"}',
  edit: '{"path","edits":[{"oldText","newText"}]}',
};

const MCP_TOOL_PREFIX = `mcp_${MCP_PROVIDER_IDENTIFIER}_`;

/** Schemas for the known local-operation tools among the given (prefixed) names. */
function schemaHints(names: string[]): string {
  const hints = names
    .map((name) => {
      const schema =
        COMMON_SCHEMAS[
          name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name
        ];
      return schema ? `${name}=${schema}` : undefined;
    })
    .filter((hint): hint is string => Boolean(hint));
  return hints.length ? ` Common schemas: ${hints.join(", ")}.` : "";
}

/** Discovery caveat plus call pattern, with schemas for any registered known tools. */
function dynamicToolGuidance(names: string[]): string {
  return (
    'Pi MCP tools are not listed by GetDynamicTools (Cursor\'s catalog omits the "pi" namespace ' +
    "although the tools are registered and callable). Invoke them via " +
    'CallDynamicTool(namespace="pi", toolName="mcp_pi_<name>", arguments={...}); ' +
    `do not report them as unregistered.${schemaHints(names)}`
  );
}

/** Identifies native file and shell requests that must be rejected in favor of Pi tools. */
export function isLocalToolExec(execCase: string): boolean {
  return Object.hasOwn(LOCAL_TOOL_HINTS, execCase);
}

const namesCache = new WeakMap<McpToolDefinition[], string[]>();
/** Caches nonempty tool names and aliases; the definitions array must remain immutable. */
export function availableToolNamesFor(tools: McpToolDefinition[]): string[] {
  const cached = namesCache.get(tools);
  if (cached) return cached;
  const names = [...new Set(tools.flatMap((tool) => [tool.toolName, tool.name]))].filter(Boolean);
  namesCache.set(tools, names);
  return names;
}

/** Lists registered tools with known matches first, custom tools visible, and bash last. */
export function localToolCandidates(execCase: string, tools: McpToolDefinition[]): string[] {
  const available = availableToolNamesFor(tools);
  const preferred = (LOCAL_TOOL_HINTS[execCase] ?? []).filter(
    (name) => name !== "bash" && available.includes(name),
  );
  // Custom tools may be more appropriate than a shell. Keep them visible even
  // when a known tool exists; names alone cannot establish their capabilities.
  return [
    ...new Set([
      ...preferred,
      ...available.filter((name) => name !== "bash"),
      ...available.filter((name) => name === "bash"),
    ]),
  ];
}

/** Explains a native rejection using registered tools and their schemas, or the current lack of tools. */
export function nativeToolRejectReason(execCase: string, tools: McpToolDefinition[]): string {
  const candidates = localToolCandidates(execCase, tools);
  const names = candidates.map(cursorMcpToolName);
  const guidance = names.length
    ? `Use the registered Pi MCP tools: ${names.join(", ")}. ` +
      "Choose a tool that supports the operation and construct arguments according to its schema; " +
      "do not copy native Cursor arguments unchanged. " +
      `${dynamicToolGuidance(names)} If none supports it, report that limitation.`
    : "No Pi MCP tools are exposed for this request, so this operation cannot be performed in this request.";
  return `Do not retry this native Cursor tool. It is unavailable. No operation was performed. ${guidance}`;
}

/** Builds prompt guidance for Pi-owned local operations, including tool-free requests. */
export function localToolPolicyText(tools: McpToolDefinition[]): string {
  const available = availableToolNamesFor(tools);
  const known = new Set(Object.values(LOCAL_TOOL_HINTS).flat());
  const names = available.filter((name) => known.has(name)).map(cursorMcpToolName);
  return (
    "Local file reads, searches, directory listings, writes, deletions and shell commands " +
    "must use Pi MCP tools. Native Cursor local tools are disabled; do not call or retry them. " +
    (available.length
      ? (names.length ? `Local Pi MCP tools: ${names.join(", ")}. ` : "") +
        "Other exposed Pi tools may also support the operation. Follow each tool's input schema. " +
        `${dynamicToolGuidance(names)} ` +
        "If no registered tool supports an operation, report that limitation."
      : "No Pi MCP tools are exposed for this request. Local operations are unavailable in this request.")
  );
}
