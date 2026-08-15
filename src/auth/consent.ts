/**
 * Consent / opt-out for reusing Cursor CLI / IDE system credentials.
 *
 * Default: allow system credential reuse (Keychain + state.vscdb + WSL host).
 * Opt out with PI_CURSOR_SYSTEM_CREDENTIALS=0|false|off|deny.
 * Force-enable with PI_CURSOR_SYSTEM_CREDENTIALS=1|true|on|allow.
 */
import { SystemCredentialPolicy } from "../types/enums.js";
import { isFalsyEnv, isTruthyEnv } from "../utils/util.js";

export { SystemCredentialPolicy, type SystemCredentialPolicyType } from "../types/enums.js";

export function resolveSystemCredentialPolicy(
  envValue: string | undefined = process.env.PI_CURSOR_SYSTEM_CREDENTIALS,
): SystemCredentialPolicy {
  if (!envValue?.trim()) return SystemCredentialPolicy.Allow;
  if (isFalsyEnv(envValue)) return SystemCredentialPolicy.Deny;
  if (isTruthyEnv(envValue)) return SystemCredentialPolicy.Allow;
  // Unknown values fail closed so misconfiguration never silently scrapes credentials.
  return SystemCredentialPolicy.Deny;
}

export function systemCredentialsAllowed(envValue?: string): boolean {
  return resolveSystemCredentialPolicy(envValue) === SystemCredentialPolicy.Allow;
}
