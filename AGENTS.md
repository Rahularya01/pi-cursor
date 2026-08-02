# AGENTS.md

Guidance and repository standards for LLM coding agents working on `@rahularya01/pi-cursor`.

---

## 1. Project Overview

`@rahularya01/pi-cursor` is a native Cursor provider extension for the **Pi Coding Agent**. It enables direct streaming communication with Cursor models (Claude, GPT-5.5, Composer, Grok, Gemini, Kimi) over HTTP/2 using Connect RPC and Protobuf binary framing.

### Core Stack

- **Runtime:** Node.js >= 22.0.0 (ESM native `"type": "module"`)
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
│   ├── h2-bridge.mjs       # Node.js HTTP/2 child process for Connect RPC
│   ├── cursor-wire.ts      # Binary framing & Protobuf message encoders/decoders
│   └── bridge.ts           # IPC bridge manager
├── stream/                 # Stream Simple adapter & session handling
│   ├── native-core.ts      # Core stream Simple interface for Pi AI
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
2. Cursor CLI / macOS Keychain (`cursor-access-token` / `cursor-refresh-token`)
3. Cursor IDE local state DB (`globalStorage/state.vscdb` on macOS, Linux, Windows, or WSL)
4. Pi OAuth store (`~/.pi/agent/auth.json` via `/login cursor`)

- Respect `PI_CURSOR_SYSTEM_CREDENTIALS=0` to opt-out of Keychain/IDE DB reading.
- Always redact tokens and sensitive authorization headers in diagnostics or logs (`redactSecrets()` from `src/utils/security.ts`).

### 4. Context-Mode & Side-Channel Injections

- Side-channel user messages (such as `<session_state>` blocks or context-mode injections) must be normalized into the system prompt via `normalizeMessagesForCursor()` in `src/stream/context-normalize.ts`.
- This ensures Cursor's message parser does not misidentify side-channel metadata as the active user prompt turn.

### 5. Reasoning Effort & Thinking Mapping

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
