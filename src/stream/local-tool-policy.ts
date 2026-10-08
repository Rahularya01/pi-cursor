/** Local operations are executed by Pi, never by the provider. */
import { create } from "@bufbuild/protobuf";

import { McpToolDefinitionSchema, type McpToolDefinition } from "../proto/agent_pb.js";
import { cursorMcpToolName, cursorMcpToolNames } from "./root-prompt.js";

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

/** Registered names advertised under something other than their usual prefixed form. */
function renamedToolNames(available: readonly string[]): Array<[string, string]> {
  const names = cursorMcpToolNames(available);
  return available
    .map((name): [string, string] => [name, names.advertised(name)])
    .filter(([name, advertised]) => advertised !== cursorMcpToolName(name));
}

const wireCache = new WeakMap<McpToolDefinition[], McpToolDefinition[]>();
/**
 * The Pi catalog as sent in RunRequest and RequestContext, under the wire names of
 * `cursorMcpToolNames`. The registry passed to dispatch keeps Pi's own names.
 */
export function wireMcpToolDefinitions(tools: McpToolDefinition[]): McpToolDefinition[] {
  const cached = wireCache.get(tools);
  if (cached) return cached;
  const names = cursorMcpToolNames(availableToolNamesFor(tools));
  let changed = false;
  const wire = tools.map((tool) => {
    const name = tool.toolName || tool.name;
    const wireName = names.wire(name);
    if (wireName === name || (tool.providerIdentifier || "pi") !== "pi") return tool;
    changed = true;
    return create(McpToolDefinitionSchema, { ...tool, name: wireName, toolName: wireName });
  });
  const result = changed ? wire : tools;
  wireCache.set(tools, result);
  return result;
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
  const toolNames = cursorMcpToolNames(availableToolNamesFor(tools));
  const names = localToolCandidates(execCase, tools).map(toolNames.advertised);
  const guidance = names.length
    ? `Use the registered Pi MCP tools: ${names.join(", ")}. ` +
      "Choose a tool that supports the operation and construct arguments according to its schema; " +
      "do not copy native Cursor arguments unchanged. If none supports it, report that limitation."
    : "No Pi MCP tools are exposed for this request, so this operation cannot be performed in this request.";
  return `Do not retry this native Cursor tool. It is unavailable. No operation was performed. ${guidance}`;
}

/** Builds prompt guidance for Pi-owned local operations, including tool-free requests. */
export function localToolPolicyText(tools: McpToolDefinition[]): string {
  const available = availableToolNamesFor(tools);
  const known = new Set(Object.values(LOCAL_TOOL_HINTS).flat());
  const names = available
    .filter((name) => known.has(name))
    .map(cursorMcpToolNames(available).advertised);
  const clashes = renamedToolNames(available).map(
    ([name, advertised]) => `call the custom tool "${name}" as ${advertised}`,
  );
  return (
    "Local file reads, searches, directory listings, writes, deletions and shell commands " +
    "must use Pi MCP tools. Native Cursor local tools are disabled; do not call or retry them. " +
    (available.length
      ? (names.length ? `Local Pi MCP tools: ${names.join(", ")}. ` : "") +
        (clashes.length ? `To avoid a name clash, ${clashes.join("; ")}. ` : "") +
        "Other exposed Pi tools may also support the operation. Follow each tool's input schema. " +
        "If no registered tool supports an operation, report that limitation."
      : "No Pi MCP tools are exposed for this request. Local operations are unavailable in this request.")
  );
}
