export function cursorEnv(name: string): string | undefined {
  return (
    process.env[`PI_CURSOR_${name}`] ||
    process.env[`CURSOR_${name}`] ||
    process.env[`PI_CURSOR_PROVIDER_${name}`]
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function sanitizeText(text: unknown): string {
  return String(text ?? "").replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}
