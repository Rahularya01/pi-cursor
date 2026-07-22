# Changelog

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
