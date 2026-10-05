/**
 * Cursor MCP tool-schema encoding.
 *
 * Pi tools use JSON Schema, while Cursor carries each schema as a protobuf
 * Value and a JSON string. Slimming compacts tool prose and schema annotations
 * but retains parameter descriptions needed to construct correct arguments.
 */
import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";

import { McpToolDefinitionSchema, type McpToolDefinition } from "../proto/agent_pb.js";
import type { OpenAIToolDef } from "./types.js";

/**
 * Whether to compact tool descriptions and nonessential schema annotations.
 * Default ON; parameter descriptions remain intact in both modes. Set
 * PI_CURSOR_SLIM_TOOLS=0 to keep the original tool definitions.
 */
export function isSlimToolsEnabled(envValue = process.env.PI_CURSOR_SLIM_TOOLS): boolean {
  const raw = envValue?.trim().toLowerCase();
  if (!raw) return true;
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

const SCHEMA_ANNOTATION_KEYS = new Set([
  "title",
  "examples",
  "default",
  "$comment",
  "$schema",
  "$id",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** Keywords whose values are maps from user-defined names to child schemas. */
const NAMED_SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  // Draft-07 dependencies values may be either child schemas or string arrays.
  "dependencies",
]);

/** Keywords whose value is one child schema or an array of child schemas. */
const CHILD_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "items",
  "additionalItems",
  "unevaluatedItems",
  "if",
  "then",
  "else",
  "not",
  "contentSchema",
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

function slimChildSchema(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) return value.map((item) => slimJsonSchema(item, depth));
  return slimJsonSchema(value, depth);
}

/**
 * Slim a map such as `properties` without interpreting its user-defined keys as
 * JSON Schema keywords. A parameter may legally be named `description`,
 * `default`, or any other annotation keyword.
 */
function slimNamedSchemaMap(value: unknown, depth: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, childSchema]) => [
      name,
      slimChildSchema(childSchema, depth),
    ]),
  );
}

/**
 * Remove nonessential annotations while preserving the executable contract
 * and argument descriptions. Traversal is keyword-aware: blindly recursing into
 * `properties` treats a parameter named `description` as an annotation and
 * leaves an invalid dangling entry in `required`.
 */
function slimJsonSchema(value: unknown, depth = 0): unknown {
  if (value == null || depth > 12 || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => slimJsonSchema(item, depth + 1));

  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (SCHEMA_ANNOTATION_KEYS.has(key) || child === undefined) continue;
    if (key === "additionalProperties" && child === true) continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    if (NAMED_SCHEMA_MAP_KEYS.has(key)) {
      out[key] = slimNamedSchemaMap(child, depth + 1);
      continue;
    }
    if (CHILD_SCHEMA_KEYS.has(key)) {
      out[key] = slimChildSchema(child, depth + 1);
      continue;
    }
    // Constraints and literal values (for example enum/const) are executable
    // data, not schema containers. Keep them byte-for-byte equivalent.
    out[key] = child;
  }
  return out;
}

function conciseToolDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) return normalized;
  const firstSentence = normalized.match(/^.{24,117}?[.!?](?:\s|$)/)?.[0]?.trim();
  return firstSentence || `${normalized.slice(0, 117)}...`;
}

/** Compact tool prose/schemas for the Cursor MCP tool surface. */
function isObjectRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function slimOpenAIToolsForCursor(tools: OpenAIToolDef[]): OpenAIToolDef[] {
  if (!isSlimToolsEnabled()) return tools;
  return tools.map((tool) => {
    if (!isObjectRecord(tool)) return tool;
    const fn = tool.function;
    if (!isObjectRecord(fn)) return tool;
    const parameters = isObjectRecord(fn.parameters)
      ? (slimJsonSchema(fn.parameters) as Record<string, unknown>)
      : fn.parameters;
    const description =
      typeof fn.description === "string" ? conciseToolDescription(fn.description) : "";
    return {
      ...tool,
      function: {
        ...fn,
        ...(description ? { description } : {}),
        ...(parameters !== undefined ? { parameters } : {}),
      },
    };
  });
}

// Pi typically hands the provider the same `tools` array reference turn after
// turn. Cache the pure schema preparation + protobuf encoding by that identity
// and the env-controlled slimming mode.
const mcpToolDefinitionsCache = new WeakMap<OpenAIToolDef[], Map<boolean, McpToolDefinition[]>>();

export function buildMcpToolDefinitions(tools: OpenAIToolDef[]): McpToolDefinition[] {
  const slimEnabled = isSlimToolsEnabled();
  const byMode = mcpToolDefinitionsCache.get(tools);
  const cached = byMode?.get(slimEnabled);
  if (cached) return cached;

  const prepared = slimOpenAIToolsForCursor(tools);
  const result: McpToolDefinition[] = [];
  for (const tool of prepared) {
    if (!isObjectRecord(tool)) continue;
    const fn = tool.function;
    if (!isObjectRecord(fn)) continue;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    const description = typeof fn.description === "string" ? fn.description : "";
    const jsonSchema: JsonValue = isObjectRecord(fn.parameters)
      ? (fn.parameters as JsonValue)
      : { type: "object", properties: {}, required: [] };
    // Current Cursor prefers field 6 and falls back to the Value in field 3.
    // Populate both from the same schema so either discovery path agrees.
    const inputSchema = fromJson(ValueSchema, jsonSchema);
    result.push(
      create(McpToolDefinitionSchema, {
        name,
        description,
        providerIdentifier: "pi",
        toolName: name,
        inputSchema,
        inputSchemaJson: JSON.stringify(jsonSchema),
      }),
    );
  }

  const modes = byMode ?? new Map<boolean, McpToolDefinition[]>();
  modes.set(slimEnabled, result);
  mcpToolDefinitionsCache.set(tools, modes);
  return result;
}
