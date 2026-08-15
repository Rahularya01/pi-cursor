export function cursorEnv(name: string): string | undefined {
  return (
    process.env[`PI_CURSOR_${name}`] ||
    process.env[`CURSOR_${name}`] ||
    process.env[`PI_CURSOR_PROVIDER_${name}`]
  );
}

export function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const raw = value.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "allow" || raw === "yes";
}

export function isFalsyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const raw = value.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "deny" || raw === "no";
}

export function cursorEnvBoolean(name: string, defaultValue = false): boolean {
  const env = cursorEnv(name);
  if (env === undefined) return defaultValue;
  if (isFalsyEnv(env)) return false;
  if (isTruthyEnv(env)) return true;
  return defaultValue;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Replace lone (unpaired) surrogates with U+FFFD; valid surrogate pairs (e.g. emoji) pass through. */
export function sanitizeText(text: unknown): string {
  return String(text ?? "").replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}
