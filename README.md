# @rahularya01/pi-cursor

[![npm version](https://img.shields.io/npm/v/@rahularya01/pi-cursor?logo=npm)](https://www.npmjs.com/package/@rahularya01/pi-cursor)
[![license](https://img.shields.io/npm/l/@rahularya01/pi-cursor)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github)](https://github.com/sponsors/Rahularya01)

Use your **Cursor** subscription's models — Composer, Claude, GPT, Grok — inside the **Pi Coding Agent**.
`pi-cursor` plugs in a `cursor` model provider that talks to Cursor's own backend directly (native
Connect/protobuf streaming over HTTP/2), so there's no separate API key to buy and no Cursor CLI
process running in the background for every chat turn. If you're already logged into Cursor's app
or CLI, it just works — no setup beyond installing the package.

> **Unofficial integration.** This project is not affiliated with or endorsed by Cursor / Anysphere. It uses reverse-engineered wire protocol details shared by community clients (see [Attributions](#attributions)). Use it only with an account you are authorized to access, and review its source before granting OAuth permissions. Cursor may change wire protocol endpoints or formats at any time.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Authentication](#authentication-and-resolution-cascade)
- [Commands](#commands)
- [Models & reasoning effort](#models-and-reasoning-effort-routing)
- [Usage dashboard](#usage-quota-and-visual-tui-dashboard)
- [Troubleshooting](#troubleshooting)
- [Configuration (advanced)](#configuration)
- [Architecture (advanced)](#architecture--wire-protocol)
- [Development](#development)

## Requirements

|                             |                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------- |
| **Pi Coding Agent / Pi AI** | version `0.80.0` or later                                                             |
| **Node.js**                 | version `22.19.0` or later (needed for native HTTP/2 streaming and credential lookup) |
| **A Cursor account**        | with model access — signed in via the Cursor app, Cursor CLI, or browser login below  |

## Install

```bash
pi install npm:@rahularya01/pi-cursor
```

Then **restart Pi** (or run `/reload`) so the new provider is picked up.

<details>
<summary>Other install options</summary>

Install the latest code straight from GitHub instead of npm:

```bash
pi install git:github.com/Rahularya01/pi-cursor
```

To update later:

```bash
pi update npm:@rahularya01/pi-cursor
```

</details>

## Quick start

1. **Sign in.** If Cursor's desktop app or CLI (`cursor` / `agent`) is already logged in on this
   machine, `pi-cursor` detects it automatically — skip to step 2. Otherwise, run:

   ```text
   /login cursor
   ```

   This opens a browser tab to sign in with your Cursor account.

2. **Pick a model:**

   ```text
   /model cursor/composer-2
   ```

3. **Start chatting.** If anything looks off, run `/cursor.doctor` — it prints which credential
   source is active, the current endpoint, and the last error, and is the first thing to check
   before filing an issue.

## Authentication and resolution cascade

`pi-cursor` automatically resolves credentials using a 4-tier cascade:

```text
1. CURSOR_ACCESS_TOKEN environment variable
2. Pi OAuth credentials store (~/.pi/agent/auth.json via /login cursor)
3. Cursor CLI credentials in macOS Keychain (cursor-access-token / cursor-refresh-token)
4. Cursor IDE local state DB (globalStorage/state.vscdb on macOS, Windows, Linux, or WSL)
```

`/login cursor` is preferred over Keychain/IDE harvest so an explicit Pi login is not silently overridden by another Cursor app account on the machine.

### Automatic CLI & IDE login detection

If you are logged into the Cursor desktop app or Cursor CLI (`cursor` / `agent`), `pi-cursor` automatically extracts your session credentials so you can start chatting immediately without manual browser login.

On **WSL (Windows Subsystem for Linux)**, `pi-cursor` reuses the **current** Windows user's Cursor IDE login (`USERPROFILE` / `USERNAME` → `/mnt/c/Users/<you>/AppData/...`). It does not scan other Windows profiles.

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

> The rest of this README is reference material for troubleshooting, tuning, and contributing —
> nothing here is required for day-to-day use.

```text
Pi Coding Agent  →  streamSimple (cursor-native)
                      → h2-bridge.mjs (Node.js HTTP/2 child process)
                      → agent.v1.AgentService/Run (Connect + Protobuf over HTTP/2)
```

- **Transport:** Native Connect/protobuf streaming over HTTP/2 via `h2-bridge.mjs`.
- **Infrastructure Context Normalization:** Side-channel user messages (context-mode routing, post-compaction `<session_state>`, and explicit `[pi-lens automated … not a user request]` notices) are safely normalized into the system prompt so Cursor models stay focused on your primary task.
- **Context-Efficient Tools:** MCP schemas are compacted without changing callable constraints, and exact conversational-only turns (`hi`, `thanks`, etc.) omit tools entirely. Actionable prompts always retain tools.
- **Cross-Platform:** Tested and fully compatible with macOS, Linux, Windows, and WSL.

## Configuration

Everything below is optional — `pi-cursor` works out of the box. These environment variables exist
for tuning timeouts, debugging, and edge-case overrides.

<details>
<summary><strong>Full environment variable reference</strong></summary>

| Variable                                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_CURSOR_AGENT_URL` / `CURSOR_AGENT_URL` | Override agent base URL (default: `https://agentn.us.api5.cursor.sh`).                                                                                                                                                                                                                                                                                                                                               |
| `CURSOR_ACCESS_TOKEN`                      | Static access token override.                                                                                                                                                                                                                                                                                                                                                                                        |
| `PI_CURSOR_CLIENT_VERSION`                 | Pin `x-cursor-client-version` header sent by the HTTP/2 bridge.                                                                                                                                                                                                                                                                                                                                                      |
| `PI_CURSOR_SYSTEM_CREDENTIALS`             | `0`/`false` to disable Keychain/IDE credential reuse (default: allow).                                                                                                                                                                                                                                                                                                                                               |
| `PI_CURSOR_RAW_MODELS`                     | Disable effort-suffix model collapse.                                                                                                                                                                                                                                                                                                                                                                                |
| `PI_CURSOR_PROVIDER_DEBUG`                 | Enable verbose JSONL debug logging.                                                                                                                                                                                                                                                                                                                                                                                  |
| `PI_CURSOR_LIFECYCLE_LOG`                  | Always-on compact lifecycle log path (default: `$TMPDIR/pi-cursor-lifecycle.jsonl`).                                                                                                                                                                                                                                                                                                                                 |
| `CURSOR_USAGE_SESSION_TOKEN`               | Optional `WorkosCursorSessionToken` fallback cookie for `/cursor.usage`.                                                                                                                                                                                                                                                                                                                                             |
| `PI_OFFLINE`                               | Skip live model discovery entirely; always use the bundled fallback catalog.                                                                                                                                                                                                                                                                                                                                         |
| `PI_CURSOR_CACHE_DIR`                      | Where the model catalog and refresh back-off are cached (default: `$XDG_CACHE_HOME/pi-cursor` or `~/.cache/pi-cursor`). Delete it to force a full rediscovery.                                                                                                                                                                                                                                                       |
| `PI_CURSOR_UNARY_BRIDGE`                   | `1` forces unary RPCs (model discovery) through the h2-bridge subprocess instead of the in-process HTTP/2 client. Diagnostic escape hatch.                                                                                                                                                                                                                                                                           |
| `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS`         | Silence safety net: ms with **no upstream work** before recover/retry/error. **Default `180000` (3 min)**; `0` disables (turns run unbounded). Text/thinking/token deltas, tool-call events, and answered execs/queries reset it; heartbeats only prove the socket and do not hide an unanswered exec. It is paused during tool execution. On timeout, recovery continues from checkpoint even after partial output. |
| `PI_CURSOR_RESUME_IDLE_TIMEOUT_MS`         | Same silence safety net after tool-result resume. **Default `180000` (3 min)**; `0` disables.                                                                                                                                                                                                                                                                                                                        |
| `PI_CURSOR_STREAM_IDLE_MAX_RETRIES`        | Auto-recovery attempts after silence/transport loss. Blind restart is skipped once text/thinking streamed unless a checkpoint is available for continuation. **Default `5`**; `0` disables.                                                                                                                                                                                                                          |
| `PI_CURSOR_ACTIVE_BRIDGE_TTL_MS`           | How long a mid-tool bridge stays parked waiting for tool results (default: 1 hour).                                                                                                                                                                                                                                                                                                                                  |
| `PI_CURSOR_H2_CONNECT_TIMEOUT_MS`          | h2-bridge initial connect kill (default: `30000`; `0` disables).                                                                                                                                                                                                                                                                                                                                                     |
| `PI_CURSOR_H2_IDLE_TIMEOUT_MS`             | h2-bridge activity idle kill. **Default `0` (disabled)**. Parent heartbeats reset it when enabled.                                                                                                                                                                                                                                                                                                                   |
| `PI_CURSOR_SLIM_TOOLS`                     | Compact Cursor MCP tool definitions: concise function purpose, no annotation-only parameter prose, full callable schema constraints preserved. **Default on**; set `0`/`false` for verbatim schemas.                                                                                                                                                                                                                 |
| `PI_CURSOR_MIDPAUSE_REBUILD_MAX_AGE_MS`    | Max age of mid-pause metadata used for full-history rebuild (default: 15 min).                                                                                                                                                                                                                                                                                                                                       |
| `PI_CURSOR_PROMPT_HISTORY`                 | Publish the system prompt and completed turns as Cursor prompt messages when a request is built without an upstream checkpoint. **Default on**; `0`/`false` restores the pre-1.4.24 behavior, where a rebuilt conversation reached the model with no history and no Pi system prompt.                                                                                                                                |

</details>

## Architecture notes

<details>
<summary><strong>Module layout (<code>src/stream/</code>)</strong></summary>

Stream modules are split under `src/stream/`:

| Module                 | Responsibility                                                        |
| ---------------------- | --------------------------------------------------------------------- |
| `types.ts`             | Shared structural types (no runtime code — safe for anyone to import) |
| `config.ts`            | Agent URL + client version resolution                                 |
| `tuning.ts`            | Timeouts, retry budgets, and the stream idle watchdog                 |
| `debug-log.ts`         | Debug / lifecycle / metric sinks with secret redaction                |
| `images.ts`            | Image decode + Cursor CLI format and size validation                  |
| `model-routing.ts`     | Effort suffix / requested model resolution                            |
| `model-discovery.ts`   | `GetUsableModels` unary RPCs + per-token model cache                  |
| `model-cache.ts`       | Cross-process catalog cache read synchronously at startup             |
| `context-normalize.ts` | Context-mode side-channel folding                                     |
| `message-parsing.ts`   | Pi/OpenAI message list → Cursor turn structures                       |
| `pi-adapter.ts`        | Pi context/model types ↔ OpenAI-shaped request, usage accounting      |
| `request-build.ts`     | `AgentRunRequest` protobuf construction + blob store                  |
| `bridge-session.ts`    | Active-bridge registry + h2-bridge lifecycle                          |
| `session-state.ts`     | Conversation store, checkpoints, key derivation, session locks        |
| `server-messages.ts`   | Inbound KV / exec / interaction dispatch                              |
| `thinking-filter.ts`   | Strips inline `<think>`-style tags from the text channel              |
| `recovery.ts`          | Tool-continuation recovery planner                                    |
| `protocol.ts`          | Auth/protocol error enhancement                                       |
| `drift.ts`             | Wire-drift detection (unknown message cases and protobuf fields)      |
| `native-core.ts`       | Native streamSimple runtime that drives all of the above              |

Native `streamSimple` is the only chat path. The OpenAI-compatible local proxy that
used to sit alongside it was removed in favour of a single code path.

### Startup

Extension activation does no network and no credential lookup. Models are registered
synchronously from the persisted catalog (`PI_CURSOR_CACHE_DIR`), falling back to the
catalog bundled in `src/models/catalog.json` on a first-ever launch. Live discovery runs
through pi's `refreshModels` hook — off the critical path, in the background, and again
whenever `/model` is opened — then persists its result for the next launch.

Unary RPCs (both discovery calls) use an in-process `node:http2` client. The h2-bridge
subprocess is still used for the bidirectional chat stream, where Bun's `node:http2` is
unusable, and remains the automatic fallback if the in-process client fails.

`src/proto/agent_pb.ts` is a large generated Connect/protobuf surface used by the wire
layer. Never hand-edit it — regenerate with `npm run proto:gen` (see
[`proto/README.md`](proto/README.md)) when Cursor changes the agent schema.

</details>

## Troubleshooting

- **`No API provider registered for api: cursor-native`:** Update to the latest `pi-cursor` (`pi update npm:@rahularya01/pi-cursor`) and restart Pi (or `/reload`). This means the Agent tried to stream via Pi's global `streamSimple` dispatcher before the Cursor transport was registered there. Current builds register `cursor-native` on that registry during extension load.
- **Not logged in / 401:** Ensure Cursor CLI or app is logged in, or run `/login cursor` again. Check `/cursor.doctor` to verify your `tokenSource`. Tokens from CLI/IDE are re-resolved when near expiry; idle stream retries also force-refresh credentials.
- **Empty / hung stream:** Cursor may have updated wire headers; verify network connectivity or bump `PI_CURSOR_CLIENT_VERSION`. `/cursor.doctor` prints the active `clientVersion`.
- **Wire-protocol drift:** Cursor can change `agent.v1` at any time. Unrecognized server messages and unknown protobuf fields are no longer skipped silently — they are counted, written to the lifecycle log as `wire_drift`, appended to the failing turn's error message, and listed by `/cursor.doctor` under `wireDrift`. `wireDriftStranding=yes` means an unanswered message could have parked the turn, which is the difference between "our schema is a bit behind" and "this is why it hung". Run `CURSOR_ACCESS_TOKEN=... npm run smoke:wire` to check the handshake and schema against the live endpoint without starting a chat turn, then see [`proto/README.md`](proto/README.md) to resync the schema.
- **Stuck / dies after a few minutes of work:** Cursor `InteractionQuery` prompts are answered so the stream does not park. Web/search and unnamed proto fields are rejected (use Pi tools instead). Inspect `$TMPDIR/pi-cursor-lifecycle.jsonl` for `interaction_query` / `bridge_close` events, and `/cursor.doctor` for `lastStreamEvent`. Full debug: `PI_CURSOR_PROVIDER_DEBUG=1`.
- **Tool continuation lost:** The provider now prefers full-history rebuild when checkpoints are stale/mismatched. If recovery still skips, `/cursor.doctor` shows `lastRecoverySkipReason`. Retry the turn or start a new chat.
- **WSL credential detection:** Set `USERPROFILE` or `USERNAME` so the Windows home directory is known, and ensure `/mnt/c/Users/<you>/AppData/...` is readable. Disable with `PI_CURSOR_SYSTEM_CREDENTIALS=0` if undesired.
- **Slow startup:** Activation should be a few milliseconds. `/cursor.doctor` reports `catalogCache` (`none(using bundled fallback)` means every launch is starting cold — check that `catalogCacheDir` is writable) and `unaryTransport`. A stale Cursor CLI keychain entry no longer blocks startup: a refresh token that fails is remembered for 10 minutes so it is not retried on the next launch, and any valid locally stored token is always preferred over a network exchange.
- **Model list looks stale:** It is the last successfully discovered catalog. Open `/model` to trigger a background refresh, or delete `PI_CURSOR_CACHE_DIR` to force full rediscovery.

## Development

```bash
npm install
npm run check
```

`npm run check` runs TypeScript typechecking, ESLint, Prettier format verification, security checks, the protobuf staleness check, and unit tests.

| Script                | Purpose                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `npm run proto:gen`   | Regenerate `src/proto/agent_pb.ts` from `proto/agent.proto`.                      |
| `npm run proto:sync`  | Rebuild `proto/agent.proto` from an updated generated file obtained upstream.     |
| `npm run proto:check` | Fail if the generated protobuf is stale or hand-edited (part of `npm run check`). |

## Attributions

Wire protocol and authentication patterns adapted from MIT community client lineage:

- [ephraimduncan/opencode-cursor](https://github.com/ephraimduncan/opencode-cursor)
- [@pi-stef/cursor](https://www.npmjs.com/package/@pi-stef/cursor)

Package structure mirrors [pi-antigravity](https://github.com/Rahularya01/pi-antigravity).

## Support the project

If `pi-cursor` is useful to you, consider [sponsoring the project on GitHub](https://github.com/sponsors/Rahularya01).

## License

[MIT](LICENSE)
