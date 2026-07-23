/**
 * Consent / opt-out for reusing Cursor CLI / IDE system credentials.
 *
 * Default: allow system credential reuse (Keychain + state.vscdb + WSL host).
 * Opt out with PI_CURSOR_SYSTEM_CREDENTIALS=0|false|off|deny.
 * Force-enable with PI_CURSOR_SYSTEM_CREDENTIALS=1|true|on|allow.
 */
export type SystemCredentialPolicy = "allow" | "deny";

export function resolveSystemCredentialPolicy(
  envValue: string | undefined = process.env.PI_CURSOR_SYSTEM_CREDENTIALS,
): SystemCredentialPolicy {
  const raw = envValue?.trim().toLowerCase();
  if (!raw) return "allow";
  if (raw === "0" || raw === "false" || raw === "off" || raw === "deny" || raw === "no") {
    return "deny";
  }
  if (raw === "1" || raw === "true" || raw === "on" || raw === "allow" || raw === "yes") {
    return "allow";
  }
  // Unknown values fail closed so misconfiguration never silently scrapes credentials.
  return "deny";
}

export function systemCredentialsAllowed(envValue?: string): boolean {
  return resolveSystemCredentialPolicy(envValue) === "allow";
}
