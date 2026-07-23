# Cursor Wire Protocol & Architecture (`pi-cursor`)

This document describes the reverse-engineered wire protocol, HTTP/2 streaming architecture, authentication cascade, and payload structure used by `@rahularya01/pi-cursor`.

## Overview

Unlike OpenAI or Anthropic API providers that use standard REST/SSE endpoints, Cursor uses a custom **Connect / Protobuf protocol over HTTP/2**:

```text
Pi Coding Agent (Extension)
    ↓ (streamSimple)
h2-bridge.mjs (Child Process)
    ↓ (HTTP/2 POST with Connect framing & Protobuf payloads)
https://agentn.us.api5.cursor.sh / https://api2.cursor.sh
```

## Protocol Specifications

- **Protocol:** Connect RPC v1 (Protobuf binary framing over HTTP/2)
- **Base Endpoint:** `https://agentn.us.api5.cursor.sh` (or overridden via `PI_CURSOR_AGENT_URL`)
- **Auxiliary Endpoint:** `https://api2.cursor.sh` (OAuth, polling, model discovery, usage)
- **Protobuf Schemas:** `src/proto/agent_pb.ts` (generated via `@bufbuild/protobuf`)

## Runtime RPC Endpoints

| RPC Path                                                   | Transport        | Description                                                                                     |
| ---------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `POST /agent.v1.AgentService/Run`                          | HTTP/2 Streaming | Primary conversational RPC. Sends `AgentClientMessage` and streams `AgentServerMessage` frames. |
| `POST /agent.v1.AgentService/GetUsableModels`              | HTTP/2 Unary     | Model discovery. Returns available account models and capabilities.                             |
| `POST /aiserver.v1.AiService/AvailableModels`              | HTTP/2 Unary     | Legacy parameterized model discovery.                                                           |
| `POST /aiserver.v1.DashboardService/GetCurrentPeriodUsage` | HTTP/2 Unary     | Usage quota endpoint. Returns plan spend, percentage used, and reset timestamps.                |

## Authentication Cascade

`pi-cursor` resolves credentials using a 4-tier fallback:

```text
1. CURSOR_ACCESS_TOKEN env var
2. macOS Keychain (cursor-access-token / cursor-refresh-token via security CLI)
3. Cursor IDE local SQLite DB (globalStorage/state.vscdb on macOS, Linux, Windows, or WSL /mnt/c/Users)
4. Pi OAuth credentials store (~/.pi/agent/auth.json via PKCE deep-link flow)
```

If an access token is expired or close to expiry, `refreshCursorToken()` sends a refresh request to `POST https://api2.cursor.sh/auth/exchange_user_api_key`.

## Context-Mode Normalization

When using extensions like `context-mode`, trailing context injections (such as `<session_state>` or routing blocks) are appended as user messages. Cursor's message parser maps conversation history into turns and treats the _last_ user message as the active prompt.

To prevent Cursor models from being derailed by side-channel injections:

1. `isContextModeSideChannelText()` identifies side-channel user messages.
2. `normalizeMessagesForCursor()` folds side-channel messages into the `system` prompt framed inside `<provider_context source="context-mode">`.
3. The user's actual prompt is preserved as `userText` for the active turn.

## Bridge Architecture (`h2-bridge.mjs`)

Because Node.js HTTP/2 client sessions require persistent stream handling, `pi-cursor` spawns a lightweight child process (`h2-bridge.mjs`) to manage the HTTP/2 connection.

- **Request:** Serialized `AgentClientMessage` binary frame.
- **Headers:** `x-cursor-client-version` (default: `cli-2026.05.01-eea359f`), `authorization: Bearer <token>`, `connect-protocol-version: 1`.
- **Response:** Streaming binary Connect frames parsed via `@bufbuild/protobuf` `fromBinary()`.
- **Idle safety net:** Connect timeout defaults to 30s (handshake only). **Activity idle is disabled by default** so long agent turns are not killed. Parent heartbeats every 5s reset the activity timer when it is enabled via `PI_CURSOR_H2_IDLE_TIMEOUT_MS`.

## Stream idle watchdog

`writeNativeStream` can arm an idle watchdog via `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS`. **Default is `0` (disabled)** so Cursor can think/tool for as long as the upstream stream stays open. When enabled, the watchdog resets on:

- non-empty text/thinking deltas
- **tokenDelta** (long pure-reasoning turns)
- handled exec round-trips (MCP tools **and** native-tool rejects)
- checkpoints, KV blob get/set, handled interaction queries

Silent retries (`PI_CURSOR_STREAM_IDLE_MAX_RETRIES`) are also **off by default**. If you re-enable them, partial text/thinking already streamed blocks blind retries to avoid duplicated output.

## Attributions

Adapted from MIT community research and lineage docs:

- [ephraimduncan/opencode-cursor](https://github.com/ephraimduncan/opencode-cursor)
- [@pi-stef/cursor](https://www.npmjs.com/package/@pi-stef/cursor)
