# AGENTS.md

Guidance and repository standards for LLM coding agents working on `@rahularya01/pi-cursor`.

---

## 1. Project Overview

`@rahularya01/pi-cursor` is a native Cursor provider extension for the **Pi Coding Agent**. It enables direct streaming communication with Cursor models (Claude, GPT-5.5, Composer, Grok, Gemini, Kimi) over HTTP/2 using Connect RPC and Protobuf binary framing.

### Core Stack

- **Runtime:** Bun >= 1.4.0 only (ESM native `"type": "module"`)
- **Peer Dependencies:** `@earendil-works/pi-ai` (>=0.80.0), `@earendil-works/pi-coding-agent` (>=0.80.0)
- **Protobuf / RPC:** `@bufbuild/protobuf` v2, `@bufbuild/buf` for schema compilation (`proto/agent.proto`)
- **Transport:** In-process HTTP/2 (`src/client/h2-session.ts` for streaming, `src/client/h2-unary.ts` for unary RPCs) — no subprocess
- **Toolchain:** Bun (package manager, script runner, test runner, bundler)
- **Build & Test:** `bun build` via `scripts/build.ts`, `typescript` (strict ESM, `tsc` still
  does the typechecking), `bun test`, `eslint`, `prettier`

---

## 2. Key Commands & Validation Workflows

Run `bun run check` before committing or completing any task. It runs the full validation suite:

```bash
# Run complete validation suite (Typecheck, Lint, Format check, Security check, Proto check, Tests)
bun run check
```

### Individual Development Commands

| Command                  | Purpose                                                                                               |
| :----------------------- | :---------------------------------------------------------------------------------------------------- |
| `bun run typecheck`      | Run TypeScript compiler check without emitting (`tsc --noEmit`)                                       |
| `bun test`               | Run unit tests (`bun test`)                                                                           |
| `bun run test:watch`     | Run tests in interactive watch mode                                                                   |
| `bun run test:legacy`    | Run legacy standalone test scripts (routing, thinking levels, usage, context normalization, CLI auth) |
| `bun run lint`           | Run ESLint across `src/` and `tests/`                                                                 |
| `bun run lint:fix`       | Automatically fix ESLint errors                                                                       |
| `bun run format`         | Format codebase using Prettier                                                                        |
| `bun run format:check`   | Verify Prettier formatting compliance                                                                 |
| `bun run build`          | Bundle TypeScript sources with `bun build` into `dist/`                                               |
| `bun run security-check` | Audit source for credential/token exposure leaks                                                      |
| `bun run proto:gen`      | Compile `proto/agent.proto` into `src/proto/agent_pb.ts` using `buf`                                  |
| `bun run proto:check`    | Verify `src/proto/agent_pb.ts` is up-to-date with `proto/agent.proto`                                 |
| `bun run proto:sync`     | Fetch and update protobuf descriptors from upstream                                                   |

### Smoke Testing

```bash
bun run smoke:auth    # Smoke test authentication resolution
bun run smoke:models  # Smoke test model discovery RPC
bun run smoke:stream  # Smoke test HTTP/2 streaming
bun run smoke:wire    # Smoke test low-level wire protocol frames
```

---

## 3. Architecture & Code Structure

```text
src/
├── index.ts                # Pi extension entrypoint & provider registration
├── usage.ts                # Usage quota dashboard & /cursor.usage handler
├── auth/                   # 4-tier credential resolution cascade
│   ├── index.ts            # Auth exports & manager
│   ├── cli-credentials.ts  # macOS Keychain, Cursor IDE SQLite DB, WSL path resolution
│   ├── oauth.ts            # PKCE browser login flow & token refresh
│   └── consent.ts          # System credentials privacy consent policy
├── client/                 # Low-level RPC & HTTP/2 transport
│   ├── h2-session.ts       # In-process HTTP/2 session for Connect RPC (streaming, bidirectional)
│   ├── h2-unary.ts         # In-process HTTP/2 client for unary RPCs (model discovery, usage)
│   ├── cursor-wire.ts      # Binary framing & Protobuf message encoders/decoders
│   └── bridge.ts           # BridgeHandle protocol framing + transport-agnostic entry point
├── stream/                 # Stream Simple adapter & session handling
│   ├── native-core.ts      # Core stream Simple interface for Pi AI
│   ├── root-prompt.ts      # Model-facing prompt messages (system prompt + replayed history)
│   ├── context-normalize.ts# Folds side-channel injections into system prompt
│   ├── thinking-filter.ts  # Reasoning effort mapping (off, minimal, low, medium, high, xhigh, max)
│   ├── model-discovery.ts  # GetUsableModels RPC & catalog mapping
│   ├── model-routing.ts    # Model alias & parameter routing
│   ├── drift.ts            # Wire protocol drift detection
│   └── recovery.ts         # Handled interaction queries & stream recovery
├── proto/                  # Generated Protobuf TypeScript bindings (DO NOT MANUALLY EDIT)
│   └── agent_pb.ts
├── diagnostics/            # Health check diagnostics (/cursor.doctor)
└── utils/                  # Security redacting & string utilities
```

---

## 4. Architectural Rules & Guidelines

### 1. Module Imports & ESM Strictness

- Repository uses native ESM (`"type": "module"`).
- **All relative imports within `src/` must specify explicit `.js` file extensions** (e.g. `import { refreshCursorToken } from "./auth/oauth.js";`).

### 2. Protobuf Files & Code Generation

- **Never edit `src/proto/agent_pb.ts` directly.**
- To modify or update Protobuf schemas, update `proto/agent.proto` and execute `bun run proto:gen`.
- Verify with `bun run proto:check`.

### 3. Authentication Cascade Policy

1. `CURSOR_ACCESS_TOKEN` environment variable
2. Pi OAuth store (`~/.pi/agent/auth.json` via `/login cursor`)
3. Cursor CLI / macOS Keychain (`cursor-access-token` / `cursor-refresh-token`)
4. Cursor IDE local state DB (`globalStorage/state.vscdb` on macOS, Linux, Windows, or WSL — current Windows user only)

- Respect `PI_CURSOR_SYSTEM_CREDENTIALS=0` to opt-out of Keychain/IDE DB reading.
- Always redact tokens and sensitive authorization headers in diagnostics or logs (`redactSecrets()` from `src/utils/security.ts`).

### 4. Context-Mode & Side-Channel Injections

- Side-channel user messages (such as `<session_state>` blocks or context-mode injections) must be normalized into the system prompt via `normalizeMessagesForCursor()` in `src/stream/context-normalize.ts`.
- This ensures Cursor's message parser does not misidentify side-channel metadata as the active user prompt turn.

### 5. Prompt Assembly: `root_prompt_messages_json` Is the Prompt

- Cursor's agent server builds the model prompt from
  `ConversationStateStructure.root_prompt_messages_json` — a list of blob ids, each holding one
  JSON message in the AI-SDK model-message shape (`user` / `assistant` / `tool`).
- `conversation_state.turns` is **state**, not prompt. The server keeps it for its own
  checkpointing and never renders it back into prompt messages. A request that carries history
  only as turn structures reaches the model as a single fresh question.
- The server discards `{"role":"system"}` entries and substitutes Cursor's own system prompt, so
  Pi's system prompt must ride a `user` message (`<rules>…</rules>`), the way Cursor frames its own.
- Historic tool activity replays as `tool-call` / `tool-result` content parts with names in
  Cursor's `mcp_pi_<tool>` form.
- All of this lives in `src/stream/root-prompt.ts` and applies only when a request is built
  _without_ an upstream checkpoint. A checkpoint already carries the server-rendered history; only
  a changed system prompt is appended to it (`refreshSystemPrompt`).

### 6. Transport: In-Process HTTP/2, Streaming and Unary

- Both streaming and unary RPCs run in-process via `node:http2`, which Bun implements natively — no subprocess is spawned anywhere in this codebase.
- Streaming (the bidirectional Connect RPC, `agent.v1.AgentService/Run`) goes through `h2-session.ts`, which opens a persistent `http2.ClientHttp2Session` and reuses it across turns (`openStream()`) instead of paying a fresh TLS/H2 handshake each time.
- Unary RPCs (model discovery, usage) use the dedicated one-shot client in `h2-unary.ts` — genuinely simpler than streaming (one write, then read to completion), kept separate rather than merged into `h2-session.ts`. `PI_CURSOR_UNARY_BRIDGE=1` forces the general-purpose `h2-session.ts` bridge as a fallback path instead, for diagnostics/testing.
- `fetch`/`undici` cannot be used for either path: Cursor's hosts speak HTTP/2 only and undici rejects the h2 preface.
- This project used to proxy the streaming RPC through a Node child process (`h2-bridge.mjs`), because Bun's `node:http2` bidirectional streaming was believed unreliable. It's gone — see [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)'s `packages/ai/src/providers/cursor.ts` for a Bun-hosted Pi fork doing the identical bidirectional pattern in-process, with its only documented Bun/H2 caveat being ALPN negotiation behind an ALPN-stripping proxy (ported as `describeH2TransportError` in `h2-session.ts`) — an environment issue, not a streaming bug. `h2-session.ts`'s module docstring explains the exit-code/retry contract (`classifyBridgeExit()` in `src/stream/transport-errors.ts`) this transport must preserve exactly; read it before touching that file.

### 7. Runtime Support: Bun Only

- Bun is the only supported runtime — no Node.js binary is required or spawned, ever. `target: "node"` in `scripts/build.ts` is still deliberate: it keeps `dist/` restricted to standard, portable APIs (`node:http2` included) rather than baking in Bun-only builtins, even though Bun is the only host actually shipped/tested.
- `node:sqlite` (auth cascade tier 4) is implemented by Bun >= 1.4 and behaves identically, including the `{ readOnly: true }` option — no fallback to `bun:sqlite` is needed.
- `bun test` supplies a `vi` compatibility shim, but not `vi.mocked`; use `mock.module()` for module factories, and prefer `toHaveBeenCalledTimes(1)` over `toHaveBeenCalledOnce()` (the latter works at runtime but is absent from `@types/bun`).

### 8. Reasoning Effort & Thinking Mapping

- Pi reasoning effort levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) map directly to Cursor's model parameter variants.
- Do not bypass model collapse or effort mapping unless `PI_CURSOR_RAW_MODELS=1` is explicitly set.

---

## 5. Environment Variables Reference

| Variable                                   | Description                                                                                                                                                          |
| :----------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CURSOR_ACCESS_TOKEN`                      | Static access token override for Cursor API calls                                                                                                                    |
| `PI_CURSOR_AGENT_URL` / `CURSOR_AGENT_URL` | Base URL override for Agent Connect RPC (default: `https://agentn.us.api5.cursor.sh`)                                                                                |
| `PI_CURSOR_SYSTEM_CREDENTIALS`             | Set to `0` or `false` to disable Keychain / IDE DB credential harvesting                                                                                             |
| `PI_CURSOR_CLIENT_VERSION`                 | Pin custom `x-cursor-client-version` header sent by the HTTP/2 transport                                                                                             |
| `PI_CURSOR_UNARY_BRIDGE`                   | Set to `1` to force unary RPCs through the general-purpose bridge transport instead of the dedicated one-shot in-process client (diagnostic escape hatch)            |
| `PI_CURSOR_PROVIDER_DEBUG`                 | Set to `1` or `true` to enable verbose debug logging to temp file                                                                                                    |
| `PI_CURSOR_RAW_MODELS`                     | Set to `1` or `true` to disable reasoning effort suffix collapsing in model picker                                                                                   |
| `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS`         | Stream silence watchdog in ms (default: `180000` / 3 min; `0` disables). Heartbeats do not reset it while an exec is unanswered; that path uses a 45s park deadline. |
| `PI_CURSOR_H2_IDLE_TIMEOUT_MS`             | HTTP/2 bridge activity idle timeout in ms (default: `0` / disabled)                                                                                                  |
| `PI_CURSOR_PROMPT_HISTORY`                 | Set to `0` or `false` to stop publishing system prompt + history as prompt messages                                                                                  |
