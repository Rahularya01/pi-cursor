# Changelog

## [1.2.2] - 2026-07-23

### Fixed

- **Root hang:** Cursor `InteractionQuery` messages (web search, Exa, ask-question, switch-mode, create-plan, WebFetch field #9, unknown fields) are now always answered. Previously only WebFetch field #9 was handled — any other permission/query left the AgentService stream parked forever ("stops after a few minutes").
- Always-on lifecycle log at `$TMPDIR/pi-cursor-lifecycle.jsonl` (override with `PI_CURSOR_LIFECYCLE_LOG`) for stream start/close and interaction handling.
- h2-bridge: HTTP/2 PING every 20s to prevent intermediary idle GOAWAY; stderr/errors are surfaced instead of swallowed.
- Parent bridge now captures child stderr; heartbeats stay referenced during long tool pauses.
- Treat `heartbeat` / tool-call start / thinking-completed / summary updates as stream progress.

## [1.2.1] - 2026-07-23

### Fixed

- Stream idle watchdog no longer treats long pure-reasoning turns as dead: `tokenDelta`, handled native-tool reject round-trips, and `toolCallCompleted` now count as progress.
- **Idle timeouts and silent retries are disabled by default** (`PI_CURSOR_STREAM_IDLE_TIMEOUT_MS=0`, `PI_CURSOR_RESUME_IDLE_TIMEOUT_MS=0`, `PI_CURSOR_STREAM_IDLE_MAX_RETRIES=0`, `PI_CURSOR_H2_IDLE_TIMEOUT_MS=0`) so agent turns can run as long as Cursor keeps the stream open. Re-enable via env if you want a safety net.
- h2-bridge activity kill is off by default and configurable (`PI_CURSOR_H2_*_TIMEOUT_MS`); parent heartbeats still reset it when enabled.
- Blind idle retries (when re-enabled) are skipped if partial text/thinking was already streamed (avoids duplicated/jumbled answers).
- Idle retries force-refresh access tokens when a token provider is available.
- Conversation blob stores are soft-capped (~128 MiB) to limit long-session memory growth.
- Tool result `isError` is propagated into Cursor MCP results.
- Context-mode side-channel detection covers additional compaction / `[context]` injections.

### Added

- `/cursor.doctor` surfaces `lastStreamEvent`, last idle timeout metadata, and configured idle timeouts.
- Documented stream/bridge idle env vars in README.
- Unit coverage for idle progress classification, blind-restart gating, blob trimming, and timeout resolvers.

## [1.2.0] - 2026-07-23

### Changed

- Package now ships a bundled, minified `dist/` build (via `tsup`) instead of raw TypeScript source. Unpacked package size dropped ~818 KB → ~222 KB (packed ~154 KB → ~69 KB) by tree-shaking the generated protobuf module (~1000 exports, ~70 used). `main` and `pi.extensions` now point at `./dist/index.js`.
- `prepare` script builds `dist/` on install, so `git:`-based installs work without a committed build.

### Fixed

- Streaming hot path: the thinking-tag filter regex is compiled once at module load instead of being rebuilt on every streamed chunk.

## [1.1.0] - 2026-07-23

### Added

- Modular stream surface: `config`, `model-routing`, `context-normalize`, `recovery`, `protocol` extracted from the native runtime.
- Vitest unit suite covering recovery, model routing, context-mode normalize, consent, protocol framing, and usage formatting.
- Mid-session token re-resolution when access tokens near expiry (all credential sources).
- System credential consent opt-out via `PI_CURSOR_SYSTEM_CREDENTIALS=0`.
- `/cursor.doctor` fields: `clientVersion`, `systemCredentials`, `lastRecoverySkipReason`, protocol/auth hints.
- Protocol mismatch / auth error message enhancement with actionable hints.

### Changed

- Tool-continuation recovery prefers full-history rebuild when checkpoints are stale or tool-id mismatched (hard skip only when rebuild is unsafe).
- OpenAI-compatible local proxy path quarantined (not part of the public `src/stream` export surface).
- Agent URL resolution validates hosts via the existing allowlist helper.
- `SECURITY.md` updated for 1.x support and system-credential policy.

## [1.0.0] - 2026-07-23

### Added

- Initial stable release of `@rahularya01/pi-cursor` provider for Pi Coding Agent.
- 4-tier authentication resolution cascade: automatically resolves tokens from `CURSOR_ACCESS_TOKEN` env var, macOS Keychain (Cursor CLI), Cursor IDE local state (`state.vscdb`), and Pi OAuth store (`~/.pi/agent/auth.json`).
- Automatic WSL (Windows Subsystem for Linux) host Windows AppData credential auto-discovery.
- Deep-link PKCE browser OAuth (`/login cursor`) with token refresh.
- Native `streamSimple` transport over Connect/protobuf HTTP/2 via `h2-bridge.mjs`.
- Live model discovery (`GetUsableModels` + parameterized metadata) with static fallback catalog.
- Effort-suffix model collapse and Pi thinking-level routing.
- Context-mode normalization: side-channel user messages (such as context-mode routing or post-compaction `<session_state>` blocks) are safely normalized into the system prompt so Cursor models stay focused on the user's task.
- Visual TUI usage dashboard (`/cursor.usage`) with progress bars, plan breakdown (`Included`, `Auto`, `API`), reset dates, and dashboard link.
- Sanitized provider diagnostics command (`/cursor.doctor`) and model catalog command (`/cursor.models`).
- GitHub Actions CI/CD workflows targeting Node 22 and 24 for automated testing and npm publishing.
