# Changelog

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
