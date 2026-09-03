/**
 * Domain enums for @rahularya01/pi-cursor.
 *
 * Strongly-typed TypeScript enums for provider constants, credentials,
 * reasoning levels, transport states, and drift signals.
 */

/** Credential origin in the resolution cascade. */
export enum CredentialSource {
  Env = "env",
  CliKeychain = "cli_keychain",
  CliKeychainRefresh = "cli_keychain_refresh",
  IdeVscdb = "ide_vscdb",
  IdeVscdbRefresh = "ide_vscdb_refresh",
  PiOAuth = "pi_oauth",
  PiOAuthRefresh = "pi_oauth_refresh",
  None = "none",
}

export type CredentialSourceType = `${CredentialSource}`;

/** Policy for system credential harvesting (Keychain, state.vscdb, WSL). */
export enum SystemCredentialPolicy {
  Allow = "allow",
  Deny = "deny",
}

export type SystemCredentialPolicyType = `${SystemCredentialPolicy}`;

/** Reasoning effort levels recognized by Pi AI. */
export enum ThinkingLevel {
  Off = "off",
  Minimal = "minimal",
  Low = "low",
  Medium = "medium",
  High = "high",
  XHigh = "xhigh",
  Max = "max",
}

export type PiThinkingLevel = `${ThinkingLevel}`;

/** Stream output block types for native streaming. */
export enum StreamBlockKind {
  Text = "text",
  Thinking = "thinking",
}

export type NativeBlockKind = `${StreamBlockKind}`;

/** Recovery decisions when encountering bridge death or tool continuation. */
export enum RecoveryKind {
  ActiveBridge = "active_bridge",
  RebuildFullHistory = "rebuild_full_history",
  Skip = "skip",
  Error = "error",
}

export type RecoveryDecisionKind = `${RecoveryKind}`;

/** Wire protocol drift signal categories. */
export enum DriftKind {
  ServerMessage = "server_message",
  InteractionUpdate = "interaction_update",
  KvMessage = "kv_message",
  InteractionQuery = "interaction_query",
  ExecMessage = "exec_message",
  UnknownFields = "unknown_fields",
}

export type DriftKindType = `${DriftKind}`;

/** Classified bridge exit and transport failure types. */
export enum TransportFailureKind {
  ConnectTimeout = "connect_timeout",
  SocketTimeout = "socket_timeout",
  ConnectionReset = "connection_reset",
  Goaway = "goaway",
  BridgeCrash = "bridge_crash",
  UpstreamSilence = "upstream_silence",
  UpstreamInternal = "upstream_internal",
  Authentication = "authentication",
  RateLimit = "rate_limit",
  ProtocolDrift = "protocol_drift",
  InvalidRequest = "invalid_request",
  Unknown = "unknown",
}

export type TransportFailureKindType = `${TransportFailureKind}`;

/** Connect RPC framing flags. */
export enum ConnectFlag {
  None = 0,
  EndStream = 0b00000010,
}

/** Provider identifier and API source constants. */
export enum ProviderConstant {
  ProviderId = "cursor",
  NativeApi = "cursor-native",
  Source = "@rahularya01/pi-cursor",
}
