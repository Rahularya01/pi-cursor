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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
