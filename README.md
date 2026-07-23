# @rahularya01/pi-cursor

[![npm version](https://img.shields.io/npm/v/@rahularya01/pi-cursor?logo=npm)](https://www.npmjs.com/package/@rahularya01/pi-cursor)
[![license](https://img.shields.io/npm/l/@rahularya01/pi-cursor)](LICENSE)

A Pi Coding Agent provider for **Cursor** models. It adds provider `cursor`, multi-source authentication resolution (macOS Keychain, Cursor IDE, WSL host, environment variables, or PKCE browser OAuth), native Connect/protobuf streaming over HTTP/2, model discovery, thinking effort routing, and visual TUI usage diagnostics—without invoking the Cursor CLI for day-to-day chat.

> **Unofficial integration.** This project is not affiliated with or endorsed by Cursor / Anysphere. It uses reverse-engineered Wire protocol details shared by community clients (see attributions). Use it only with an account you are authorized to access, and review its source before granting OAuth permissions. Cursor may change wire protocol endpoints or formats at any time.

## Requirements

- Pi Coding Agent and Pi AI version **0.80.0 or later**
- A Cursor account with model access (or Cursor CLI / Cursor IDE logged in on your machine)
- Node.js version **22.0.0 or later** (for native HTTP/2 Connect streaming and SQLite credential resolution)

## Install

Install from npm:

```bash
pi install npm:@rahularya01/pi-cursor
```

Or install the latest repository version:

```bash
pi install git:github.com/Rahularya01/pi-cursor
```

Restart Pi (or run `/reload`) after installation. To update the package later, run `pi update npm:@rahularya01/pi-cursor`.

## Quick start

1. If you are already logged in to Cursor CLI or the Cursor app on your machine, `pi-cursor` auto-detects your credentials. Otherwise, start Pi and run `/login cursor` to sign in via browser.
2. Select a model, for example:

   ```text
   /model cursor/composer-2
   ```

3. Start working. Use `/cursor.doctor` to verify diagnostics and active authentication source.

## Authentication and resolution cascade

`pi-cursor` automatically resolves credentials using a 4-tier cascade:

```text
1. CURSOR_ACCESS_TOKEN environment variable
2. Cursor CLI credentials in macOS Keychain (cursor-access-token / cursor-refresh-token)
3. Cursor IDE local state DB (globalStorage/state.vscdb on macOS, Windows, Linux, or WSL)
4. Pi OAuth credentials store (~/.pi/agent/auth.json via /login cursor)
```

### Automatic CLI & IDE login detection

If you are logged into the Cursor desktop app or Cursor CLI (`cursor` / `agent`), `pi-cursor` automatically extracts your session credentials so you can start chatting immediately without manual browser login.

On **WSL (Windows Subsystem for Linux)**, `pi-cursor` automatically scans Windows host user profiles (`/mnt/c/Users/*/AppData/...`) to detect and reuse your Windows Cursor app login.

To **opt out** of Keychain / IDE / WSL credential reuse (OAuth or `CURSOR_ACCESS_TOKEN` only):

```bash
export PI_CURSOR_SYSTEM_CREDENTIALS=0
```

### Deep-link PKCE browser login

When no local credentials exist, running `/login cursor` initiates browser sign-in:

1. `/login cursor` opens `https://cursor.com/loginDeepControl?...`
2. Pi polls `https://api2.cursor.sh/auth/poll` until authentication completes.
3. Access and refresh tokens are stored in Pi's auth store (`~/.pi/agent/auth.json`).
4. Tokens are automatically refreshed via `https://api2.cursor.sh/auth/exchange_user_api_key`.

Use `/cursor.doctor` to inspect which source is active (`tokenSource=cli_keychain`, `tokenSource=ide_vscdb`, `tokenSource=pi_oauth`, `tokenSource=env`).

## Commands

| Command              | Description                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `/login cursor`      | Sign in to Cursor via browser PKCE and refresh the live model catalog.                           |
| `/model cursor/<id>` | Choose a registered Cursor model.                                                                |
| `/cursor.models`     | List active runtime models, context windows, and effort capabilities.                            |
| `/cursor.models all` | Include tab/chat internal model variants normally hidden from the picker.                        |
| `/cursor.usage`      | Display visual TUI usage dashboard (included/auto/API quota bars, reset dates, on-demand spend). |
| `/cursor.doctor`     | Show sanitized provider diagnostics, active token source, endpoint, and last error.              |

## Models and reasoning effort routing

`pi-cursor` discovers live account models via `GetUsableModels` and parameterized metadata. Reasoning effort levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) are mapped directly to Cursor's runtime model variants or reasoning parameters.

| Public model ID          | Context | Thinking | Description / Routing                                      |
| ------------------------ | ------- | -------- | ---------------------------------------------------------- |
| `cursor/composer-2`      | 200,000 | Yes      | Cursor's agentic model with fast reasoning effort options. |
| `cursor/composer-1.5`    | 200,000 | Yes      | Fast agent model optimized for code edit turns.            |
| `cursor/claude-sonnet-5` | 200,000 | Yes      | Anthropic Claude Sonnet via Cursor infrastructure.         |
| `cursor/gpt-5.5`         | 200,000 | Yes      | OpenAI flagship model with parameterized reasoning levels. |
| `cursor/grok-4.5`        | 200,000 | Yes      | xAI Grok model via Cursor infrastructure.                  |

To restrict which models Pi displays, configure `~/.pi/agent/settings.json`:

```json
{
  "enabledModels": ["cursor/composer-2", "cursor/claude-sonnet-5", "cursor/gpt-5.5"]
}
```

## Usage quota and visual TUI dashboard

Running `/cursor.usage` displays a formatted terminal interface showing your current billing cycle, progress bars for included plan quota, auto/API usage, reset dates, and on-demand spend:

```text
Usage • Pro                                           Resets 5 Aug
Monthly plan and on-demand usage

Category        Current          Usage
Included        13% used         ███░░░░░░░░░░░░░░░░░
  Auto          12% used         ███░░░░░░░░░░░░░░░░░
  API           14% used         ███░░░░░░░░░░░░░░░░░
On-Demand       Disabled
------------------------------------------------------------
On-demand usage is off

View in dashboard: cursor.com/dashboard?tab=usage
```

Usage statistics are fetched directly from Cursor's native Connect period usage endpoint (`POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`) using your active access token, with optional fallback to `CURSOR_USAGE_SESSION_TOKEN`.

## Architecture & Wire Protocol

```text
Pi Coding Agent  →  streamSimple (cursor-native)
                      → h2-bridge.mjs (Node.js HTTP/2 child process)
                      → agent.v1.AgentService/Run (Connect + Protobuf over HTTP/2)
```

- **Transport:** Native Connect/protobuf streaming over HTTP/2 via `h2-bridge.mjs`.
- **Context-Mode Normalization:** Side-channel user messages (such as context-mode routing or post-compaction `<session_state>` blocks) are safely normalized into the system prompt so Cursor models stay focused on your primary task.
- **Cross-Platform:** Tested and fully compatible with macOS, Linux, Windows, and WSL.

## Configuration

| Variable                                   | Purpose                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `PI_CURSOR_AGENT_URL` / `CURSOR_AGENT_URL` | Override agent base URL (default: `https://agentn.us.api5.cursor.sh`).                                       |
| `CURSOR_ACCESS_TOKEN`                      | Static access token override.                                                                                |
| `PI_CURSOR_CLIENT_VERSION`                 | Pin `x-cursor-client-version` header sent by the HTTP/2 bridge.                                              |
| `PI_CURSOR_SYSTEM_CREDENTIALS`             | `0`/`false` to disable Keychain/IDE credential reuse (default: allow).                                       |
| `PI_CURSOR_RAW_MODELS`                     | Disable effort-suffix model collapse.                                                                        |
| `PI_CURSOR_PROVIDER_DEBUG`                 | Enable JSONL debug logging (`/tmp/pi-cursor-debug.jsonl`).                                                   |
| `CURSOR_USAGE_SESSION_TOKEN`               | Optional `WorkosCursorSessionToken` fallback cookie for `/cursor.usage`.                                     |
| `PI_OFFLINE`                               | Skip live model discovery on startup.                                                                        |
| `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS`         | Stream idle watchdog. **Default `0` (disabled)** so turns can run unbounded. Set e.g. `600000` to re-enable. |
| `PI_CURSOR_RESUME_IDLE_TIMEOUT_MS`         | Idle timeout after tool-result resume. **Default `0` (disabled)**.                                           |
| `PI_CURSOR_STREAM_IDLE_MAX_RETRIES`        | Silent full-request retries after idle. **Default `0` (disabled)**.                                          |
| `PI_CURSOR_ACTIVE_BRIDGE_TTL_MS`           | How long a mid-tool bridge stays parked waiting for tool results (default: 1 hour).                          |
| `PI_CURSOR_H2_CONNECT_TIMEOUT_MS`          | h2-bridge initial connect kill (default: `30000`; `0` disables).                                             |
| `PI_CURSOR_H2_IDLE_TIMEOUT_MS`             | h2-bridge activity idle kill. **Default `0` (disabled)**. Parent heartbeats reset it when enabled.           |
| `PI_CURSOR_MIDPAUSE_REBUILD_MAX_AGE_MS`    | Max age of mid-pause metadata used for full-history rebuild (default: 15 min).                               |

## Architecture notes

Stream modules are split under `src/stream/`:

| Module                 | Responsibility                                      |
| ---------------------- | --------------------------------------------------- |
| `config.ts`            | Agent URL + client version resolution               |
| `model-routing.ts`     | Effort suffix / requested model resolution          |
| `context-normalize.ts` | Context-mode side-channel folding                   |
| `recovery.ts`          | Tool-continuation recovery planner                  |
| `protocol.ts`          | Auth/protocol error enhancement                     |
| `native-core.ts`       | Native streamSimple runtime + (internal) proxy path |

The OpenAI-compatible local proxy remains **internal/quarantined** (not exported from `src/stream/index.ts`). Day-to-day chat uses native `streamSimple` only.

`src/proto/agent_pb.ts` is a large generated Connect/protobuf surface used by the wire layer. Prefer regenerating it from upstream protos when Cursor changes the agent schema rather than hand-editing.

## Troubleshooting

- **Not logged in / 401:** Ensure Cursor CLI or app is logged in, or run `/login cursor` again. Check `/cursor.doctor` to verify your `tokenSource`. Tokens from CLI/IDE are re-resolved when near expiry; idle stream retries also force-refresh credentials.
- **Empty / hung stream:** Cursor may have updated wire headers; verify network connectivity or bump `PI_CURSOR_CLIENT_VERSION`. `/cursor.doctor` prints the active `clientVersion`.
- **Stuck / dies after a few minutes of work:** Idle watchdogs are **off by default**. If you re-enabled them via env, set `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS=0` and `PI_CURSOR_H2_IDLE_TIMEOUT_MS=0`. Check `/cursor.doctor` for `lastIdleTimeoutAt` / `lastStreamEvent`. Enable `PI_CURSOR_PROVIDER_DEBUG=1` and inspect `/tmp/pi-cursor-debug.jsonl`.
- **Tool continuation lost:** The provider now prefers full-history rebuild when checkpoints are stale/mismatched. If recovery still skips, `/cursor.doctor` shows `lastRecoverySkipReason`. Retry the turn or start a new chat.
- **WSL credential detection:** Ensure your Windows user profile folder exists under `/mnt/c/Users/` and is readable from WSL. Disable with `PI_CURSOR_SYSTEM_CREDENTIALS=0` if undesired.

## Development

```bash
npm install
npm run check
```

`npm run check` runs TypeScript typechecking, ESLint, Prettier format verification, security checks, and unit tests.

## Attributions

Wire protocol and authentication patterns adapted from MIT community client lineage:

- [ephraimduncan/opencode-cursor](https://github.com/ephraimduncan/opencode-cursor)
- [@pi-stef/cursor](https://www.npmjs.com/package/@pi-stef/cursor)

Package structure mirrors [pi-antigravity](https://github.com/Rahularya01/pi-antigravity).

## License

[MIT](LICENSE)
