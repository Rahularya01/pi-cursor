# AGENTS.md

Guidance and repository standards for LLM coding agents working on `@rahularya01/pi-cursor`.

---

## 1. Project Overview

`@rahularya01/pi-cursor` is a native Cursor provider extension for the **Pi Coding Agent**. It enables direct streaming communication with Cursor models (Claude, GPT-5.5, Composer, Grok, Gemini, Kimi) over HTTP/2 using Connect RPC and Protobuf binary framing.

### Core Stack

- **Runtime:** Node.js >= 22.19.0 (ESM native `"type": "module"`)
- **Peer Dependencies:** `@earendil-works/pi-ai` (>=0.80.0), `@earendil-works/pi-coding-agent` (>=0.80.0)
- **Protobuf / RPC:** `@bufbuild/protobuf` v2, `@bufbuild/buf` for schema compilation (`proto/agent.proto`)
- **Transport:** Native HTTP/2 child-process bridge (`src/client/h2-bridge.mjs`)
- **Build & Test:** `tsup`, `typescript` (strict ESM), `vitest`, `eslint`, `prettier`

---

## 2. Key Commands & Validation Workflows

Run `npm run check` before committing or completing any task. It runs the full validation suite:

```bash
# Run complete validation suite (Typecheck, Lint, Format check, Security check, Proto check, Vitest)
npm run check
```

### Individual Development Commands

| Command                  | Purpose                                                                                               |
| :----------------------- | :---------------------------------------------------------------------------------------------------- |
| `npm run typecheck`      | Run TypeScript compiler check without emitting (`tsc --noEmit`)                                       |
| `npm test`               | Run Vitest unit tests (`vitest run`)                                                                  |
| `npm run test:watch`     | Run Vitest in interactive watch mode                                                                  |
| `npm run test:legacy`    | Run legacy standalone test scripts (routing, thinking levels, usage, context normalization, CLI auth) |
| `npm run lint`           | Run ESLint across `src/` and `tests/`                                                                 |
| `npm run lint:fix`       | Automatically fix ESLint errors                                                                       |
| `npm run format`         | Format codebase using Prettier                                                                        |
| `npm run format:check`   | Verify Prettier formatting compliance                                                                 |
| `npm run build`          | Bundle TypeScript sources with `tsup` into `dist/`                                                    |
| `npm run security-check` | Audit source for credential/token exposure leaks                                                      |
| `npm run proto:gen`      | Compile `proto/agent.proto` into `src/proto/agent_pb.ts` using `buf`                                  |
| `npm run proto:check`    | Verify `src/proto/agent_pb.ts` is up-to-date with `proto/agent.proto`                                 |
| `npm run proto:sync`     | Fetch and update protobuf descriptors from upstream                                                   |

### Smoke Testing

```bash
npm run smoke:auth    # Smoke test authentication resolution
npm run smoke:models  # Smoke test model discovery RPC
npm run smoke:stream  # Smoke test HTTP/2 streaming
npm run smoke:wire    # Smoke test low-level wire protocol frames
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
│   ├── h2-bridge.mjs       # Node.js HTTP/2 child process for Connect RPC (streaming)
│   ├── h2-unary.ts         # In-process HTTP/2 client for unary RPCs (model discovery, usage)
│   ├── cursor-wire.ts      # Binary framing & Protobuf message encoders/decoders
│   └── bridge.ts           # Bridge process spawn/IPC manager
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
- To modify or update Protobuf schemas, update `proto/agent.proto` and execute `npm run proto:gen`.
- Verify with `npm run proto:check`.

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

### 6. Transport Choice: In-Process vs. Bridge Subprocess

- Streaming RPCs always go through the `h2-bridge.mjs` child process — Node's `node:http2` bidirectional streaming has known issues under some runtimes, which is why the bridge exists.
- Unary RPCs (model discovery, usage) use the in-process HTTP/2 client in `h2-unary.ts` instead, to avoid paying a process-spawn + fresh TLS/H2 handshake cost for a single request/response round trip.
- `fetch`/`undici` cannot be used for either path: Cursor's hosts speak HTTP/2 only and undici rejects the h2 preface.

### 7. Reasoning Effort & Thinking Mapping

- Pi reasoning effort levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) map directly to Cursor's model parameter variants.
- Do not bypass model collapse or effort mapping unless `PI_CURSOR_RAW_MODELS=1` is explicitly set.

---

## 5. Environment Variables Reference

| Variable                                   | Description                                                                           |
| :----------------------------------------- | :------------------------------------------------------------------------------------ |
| `CURSOR_ACCESS_TOKEN`                      | Static access token override for Cursor API calls                                     |
| `PI_CURSOR_AGENT_URL` / `CURSOR_AGENT_URL` | Base URL override for Agent Connect RPC (default: `https://agentn.us.api5.cursor.sh`) |
| `PI_CURSOR_SYSTEM_CREDENTIALS`             | Set to `0` or `false` to disable Keychain / IDE DB credential harvesting              |
| `PI_CURSOR_CLIENT_VERSION`                 | Pin custom `x-cursor-client-version` header sent by `h2-bridge.mjs`                   |
| `PI_CURSOR_PROVIDER_DEBUG`                 | Set to `1` or `true` to enable verbose debug logging to temp file                     |
| `PI_CURSOR_RAW_MODELS`                     | Set to `1` or `true` to disable reasoning effort suffix collapsing in model picker    |
| `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS`         | Stream silence watchdog in ms (default: `180000` / 3 min; `0` disables)               |
| `PI_CURSOR_H2_IDLE_TIMEOUT_MS`             | HTTP/2 bridge activity idle timeout in ms (default: `0` / disabled)                   |
| `PI_CURSOR_PROMPT_HISTORY`                 | Set to `0` or `false` to stop publishing system prompt + history as prompt messages   |
