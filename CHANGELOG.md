# Changelog

## [1.4.25] - 2026-08-20

### Fixed

- **Cursor never saw the conversation history or Pi's system prompt on a rebuilt request.** The provider carried history as `conversation_state.turns` structures, but Cursor's server builds the model prompt from `root_prompt_messages_json` and never renders turn structures back into prompt messages — so any request built without an upstream checkpoint (first turn of a resumed session, checkpoint discarded, conversation rotated, Pi restarted) reached the model as a single fresh question with no memory of the chat. The same list was carrying Pi's system prompt as a `{"role":"system"}` entry, which the server discards in favour of Cursor's own IDE prompt; that is why turns came back in Cursor's voice and called native Cursor tools (`Grep`, `read`) that do not exist in Pi. Requests built without a checkpoint now publish the system prompt as a `<rules>` user message and replay every completed turn as `user` / `assistant` / `tool` prompt messages, with historic tool calls named the way Cursor names MCP tools (`mcp_pi_<tool>`). Set `PI_CURSOR_PROMPT_HISTORY=0` to restore the old behaviour.
- **Every reasoning-model turn threw away a perfectly good checkpoint.** The history fingerprint that decides whether a stored checkpoint still matches Pi's transcript hashed thinking steps. The provider records a turn's steps as it streams and never records a thinking step, while Pi replays one on the next turn, so the two fingerprints could not agree for any model that emits reasoning. Each turn was scored as a rewritten history: checkpoint discarded, `conversationId` rotated, history rebuilt — into the path above that dropped it. Reasoning is now excluded from the fingerprint; a rewritten user turn or tool call is still detected.
- A conversation's system prompt is no longer pinned to whatever the first turn happened to say. Pi rewrites it as a session evolves (context-mode folds session memory into it), and a checkpoint froze the original; a changed prompt is now re-published onto the checkpointed conversation.

## [1.4.24] - 2026-08-20

### Fixed

- **Unnamed InteractionQuery field 9 no longer kills the in-flight turn.** 1.4.23 fail-closed without sending an `InteractionResponse`, so Cursor parked and `processServerMessage` threw (`stopReason: error`). Field 9 is still rejected (not approved); we now answer with a reject-shaped response so the stream continues. Fixes [#10](https://github.com/Rahularya01/pi-cursor/issues/10).
- **Idle/transport restart after a tool pause matches Pi's in-flight turn, not the bridge suffix.** Multi-round chains and a second bridge loss in the same turn were dying with `pending_tool_call_mismatch` because recovery compared the last writeNativeStream round against every tool result Pi replayed. Resume planning now uses the parsed client turn; recovered streams carry a `ClientTranscript` so mid-pause snapshots stay keyed to Pi's history. Duplicate re-emitted exec ids are collapsed (last result wins). Ports the diagnoses from [#8](https://github.com/Rahularya01/pi-cursor/pull/8) and [#9](https://github.com/Rahularya01/pi-cursor/pull/9).
- **Blob store entry bound evicts oldest-first instead of failing the conversation.** Crossing 512 distinct blobs threw on every later turn. Eviction happens before the write is acked; an incoming blob that cannot fit even in an empty store is still rejected without punching holes. Inspired by [#11](https://github.com/Rahularya01/pi-cursor/pull/11).

## [1.4.23] - 2026-08-19

### Fixed

- **Tool continuation after an idle timeout no longer discards a valid checkpoint as `stale_checkpoint`.** Abort/idle persistence treated the in-flight turn as completed (`checkpointTurnCount + 1`) and cleared mid-pause metadata, so the next retry skipped recovery. In-flight checkpoints are now keyed to the completed-turn history only. Fixes [#5](https://github.com/Rahularya01/pi-cursor/issues/5).
- **`/login cursor` is no longer overridden by IDE/CLI credentials.** Cascade is now env → Pi OAuth → Keychain → IDE DB. Rotated OAuth refresh tokens are written back to `auth.json`.
- **WSL no longer reads every Windows user's Cursor `state.vscdb`.** Only the current Windows account (`USERPROFILE` / `USERNAME`) is considered.
- **Unknown Cursor exec messages fail closed** instead of sending a guessed empty MCP result.
- **Web/search InteractionQuery is rejected by default**; unnamed proto field 9 and Cursor mode-switches no longer auto-approve.
- Refresh error bodies and debug logs redact refresh tokens / JWTs. `security-check` also flags committed JWTs and session cookies. README engines match Node `>=22.19.0`.

## [1.4.22] - 2026-08-18

### Fixed

- **Greetings and "who are you" were answered in Cursor's voice, not Pi's.** Trivial conversational turns drop tools and blank the system prompt so a bare "hi" does not spend tens of thousands of input tokens on the agent prompt. The allowlist also held identity and capability questions — `who are you`, `what can you do for me`, `tell me about yourself` — whose answer _is_ the system prompt, so exactly those turns reached Cursor carrying no prompt at all and came back describing Cursor's IDE assistant. The allowlist is now split: pleasantries still drop the prompt, identity and capability turns keep it, and both still omit tools. A dropped prompt is no longer empty either — it carries a one-line "You are running inside Pi, not the Cursor IDE", so a greeting cannot be answered in Cursor's voice either. `tools_omitted` records whether the prompt was dropped.
- **The bundled fallback catalog under-reported the context window of every 1M Claude model by 5x.** Ten rows — `claude-4.6-opus-high`, `claude-4.6-opus-max`, `claude-4.6-sonnet-medium`, `claude-4.5-sonnet`, `claude-4-sonnet-1m` and their `-thinking` variants — carried `contextWindow: 200000` while their own display names read "1M". Live discovery infers the window from the id and name and had these right; only the offline snapshot was wrong, so the bad number surfaced precisely when discovery was unavailable. The rows are corrected, and `FALLBACK_MODELS` now derives `contextWindow` the same way it already derived `reasoning`, so the file cannot drift back out of agreement.
- **Every model advertised a 64K output ceiling.** `maxTokens` was a hardcoded `64_000` at all three places a model row is built, so Claude 4.6 and the GPT-5 family were reported at half their real limit. Cursor's `ModelDetails` carries no output ceiling, so it is now inferred from the id and display name alongside the context window: Claude 4.6+ and GPT-5 report 128K, and everything else — Claude 4.5 and older, Haiku 4.5, Composer, Gemini, Grok, Kimi, and `Auto` — keeps the 64K floor. This is Pi-side budgeting metadata only; the Cursor run request has no output-token field.

### Internal

- Context-window and output-token inference moved to a dependency-free `src/models/limits.ts`, re-exported from `src/stream/model-discovery.ts`. Importing them directly would have made the startup-path model catalog pull in the bridge and HTTP/2 transport modules at runtime, where it previously had only an erased `import type`.

## [1.4.21] - 2026-08-18

### Fixed

- **Session switch/fork/shutdown deleted the on-disk conversation journal.** Switching chats (or `/fork`, `/tree`, shutdown) killed the HTTP/2 bridge _and_ `unlink`d the journal that `/resume` hydrates from. The next turn in that session had no Cursor checkpoint and rebuilt without the compacted summary — it looked like the chat had forgotten the conversation. Those hooks now only tear down bridges; the journal stays until TTL eviction.
- **Trivial turns (`hi` / `ok`) blanked a system prompt that held folded session memory.** Greetings omit tools _and_ used to drop the system prompt to save tokens. After compaction that prompt is where the recovered `<session_state>` lives, so a short follow-up started from a blank slate. The prompt is kept when it contains provider-context / session-resume memory; tools are still omitted.
- **Compaction and resume summaries were framed as disposable infrastructure.** The same "latest user message is the only task; do not continue prior work" banner wrapped live context-mode injections _and_ recovered `<summary>` / `<session_resume>` blocks, so the model treated the compacted memory as noise. Resume/compaction side-channels now say they are active memory to continue from. Empty hierarchy+mode-only injections are still dropped; a real `<summary>` is kept even when short. Trailing user text after `</session_state>` is no longer capped at 500 characters.
- **A compacted Pi transcript kept the old Cursor `conversationId`.** When turn count or history fingerprint no longer matched the checkpoint, the checkpoint was discarded but the id stayed, so the next rebuild attached to a Cursor conversation whose history no longer existed. Those mismatches now rotate `conversationId`. A KV blob miss does the same: drop the checkpoint, rotate, persist — instead of answering the miss with an empty blob and leaving the hole in place.
- **Replayed history dropped thinking.** Pi thinking blocks never became Cursor `ThinkingMessage` steps, so a rebuild after checkpoint loss lost the reasoning that earlier turns had produced. Thinking is now carried on the OpenAI-shaped assistant message and encoded as a turn step.
- **Native Cursor execs (read / shell / …) stalled or listed the workspace to "recover" context.** Rejects now name the matching Pi MCP tool when one is advertised (`read` → `read`, `shellArgs` → `bash`, …). The system prompt also states the session is running inside Pi, not Cursor IDE.

### Performance

- **The HTTP/2 bridge process is reused across user turns.** Each turn previously spawned `h2-bridge.mjs` and did a fresh TLS + HTTP/2 handshake. A completed stream now keeps the child and session; the next turn sends `{"cmd":"open"}` and a new Connect stream. Spawn + handshake remain only for the first turn, after an idle TTL, or when the session is switched away. Mid-tool pauses still hold the live stream as before.

## [1.4.20] - 2026-08-18

### Fixed

- **An interrupted assistant turn replayed as one that simply trailed off.** Cursor's turn structure carries only the text a turn produced, so a turn that was aborted, errored, or truncated came back on the next request indistinguishable from a model that chose to stop — pi's `stopReason` and `errorMessage` were dropped entirely. Resuming a session after an interrupted turn therefore looked to the model like missing context rather than incomplete work: in the session that surfaced this, "continue please" sent the model listing the workspace and reading unrelated agent transcripts, from which it confabulated a prior discussion that never happened. Completed turns are untouched; a turn that did not finish now carries an explicit trailing note (`[pi-cursor: this assistant turn was interrupted before it finished; …]`) placed after any tool calls it managed to emit. Error detail rides along, redacted through `redactSecrets()` and capped at 200 characters. A trailing interrupted turn — the one being retried, not history behind us — is deliberately left unannotated so the live user text is not stranded.
- **Conversation journals silently dropped all but the newest 64 blobs.** The live blob store holds up to `MAX_ACTIVE_BLOB_ENTRIES` (512) entries, but the on-disk journal that survives a restart persisted only 64. A checkpoint addresses its history by blob id, so a restored checkpoint referencing an evicted blob asked for content that was gone — and `getBlobArgs` answers a miss with an empty result, which is indistinguishable from an empty blob. The conversation came back structurally intact with its older turns blank, with no error at any layer. Journals now persist the whole store under a byte budget derived from the record's actual checkpoint size, and a record that still could not fit everything is marked so the reader drops its checkpoint and rebuilds from pi's transcript instead of resuming with holes. Roughly 15–20 turns was enough to cross the old cap.
- **A blob miss is no longer invisible.** `getBlobArgs` for a blob we do not hold now records `kv_blob_miss` in the lifecycle log and in `/cursor.doctor`'s `lastStreamEvent`, so this class of silent history loss is diagnosable from the sanitized log alone.

## [1.4.19] - 2026-08-17

### Performance

- **Stopped reading whole journals to check one timestamp.** The run-journal TTL sweep runs once per user turn, on the main thread, and read plus `JSON.parse`d every journal file — megabytes of base64 blobs each — only to look at the `savedAt` field near the front of the record. It now reads a 512-byte head through a single file descriptor, falling back to a full parse only when the head does not carry the field; stale journals are rejected from the same head instead of decoding their blobs first. ~138x faster over a 25-journal cache directory (896ms → 6.5ms).
- **Image dedup no longer hashes every payload.** `mergeImages()` sha256'd every image on every history replay. Duplicates must agree on MIME type and byte length, so shapes are bucketed first and only images colliding on shape are digested, with digests memoized by buffer identity. ~700x faster replaying a 12-image transcript, and ~5x on cold buffers with distinct sizes.
- **Removed a `process.env` read from the per-token path.** `debugLog()` re-resolved `PI_CURSOR_PROVIDER_DEBUG` on every call, including once per streamed token. `process.env` is a native-backed proxy costing roughly 100x an ordinary property read, which made it the single largest cost in `processServerMessage()`. The flag is now resolved once, lazily. ~8x faster per server message.
- **Fixed O(n²) model catalog building on the activation path.** `hasVariantParameterSet()` re-normalized all of a model's variants for each of that model's variants, so catalog building scaled quadratically in string sorts. The advertised parameter sets are now derived once per model. ~5x faster, taking the whole activation model chain from 3.75ms to 1.0ms. The canonical key sorts also moved off `localeCompare`, which was needlessly slow and could rank distinct strings as equal — leaving the key dependent on input order.
- **Dropped dead work from side-channel splitting.** `splitUserTextAndSideChannel()` evaluated seven regexes and seven full-string trims per user message inside an `if` block with an empty body, then discarded the result.
- **Memoized journal blob encoding.** A conversation's blobs are carried over unchanged across the journal writes triggered by each tool-call pause, so their base64 encoding is now cached by buffer identity rather than recomputed per write.

No behavior change; startup module load was measured and deliberately left alone (the extension's own bundle imports in ~13ms — the rest is pi's peer dependencies).

## [1.4.18] - 2026-08-16

### Added

- **Forensic diagnostics for a desynced Connect frame boundary.** If a `Connect message exceeds N bytes` desync recurs, `PI_CURSOR_PROVIDER_DEBUG=1`'s lifecycle log now captures the bytes consumed and frames parsed before the desync, the raw frame header, and up to 32 trailing context bytes — enough to tell a real corrupted stream apart from a parser bug without needing a live repro. No cost when debug logging is off.

## [1.4.17] - 2026-08-16

### Fixed

- **A corrupted/misaligned incoming Connect frame (`Connect message exceeds 67108864 bytes`) no longer fails the turn outright.** This case bypassed the existing transport-loss retry machinery used for every other bridge failure (GOAWAY, connection reset, auth, ...). It's now treated the same way: the bridge is killed and, since the desync is local per-connection state rather than a permanent condition, the turn resumes over a fresh connection via checkpoint/history recovery when possible, falling back to the same error as before only when a retry isn't safe or attempts are exhausted.
- Added a randomized differential test for the Connect frame reassembly logic (chunk-boundary fragmentation, large frames split across many tiny reads), which also caught and fixed a correctness bug in the chunk accumulator introduced in 1.4.16 — verified byte-for-byte against a reference implementation across many trials.

## [1.4.16] - 2026-08-16

### Performance

- **Eliminated O(n²) frame reassembly on the streaming hot path.** The bridge's stdout reader, the Connect frame parser, and `h2-bridge.mjs`'s stdin reader all re-concatenated the entire buffered backlog on every incoming chunk, which is quadratic in a frame's total size once it arrives split across many small reads (large tool results, images, checkpoints). Replaced with a chunk-array accumulator that only merges what's needed to make progress — up to ~690x faster reassembling a large frame from small chunks in benchmarks.
- **Cached checkpoint history fingerprinting.** `fingerprintCompletedTurns()` re-serialized and hashed the full completed-turn history from scratch on every call, even though it runs multiple times per turn over overlapping turn arrays. Added a per-turn cache keyed by turn-object identity.
- **Memoized MCP tool schema slimming.** `buildMcpToolDefinitions()` and the derived MCP tool-name list re-slimmed and re-encoded every tool's schema on every call, even when the underlying tool set was unchanged from the previous turn. Both are now cached by array identity.

## [1.4.15] - 2026-08-15

### Documentation

- **README Onboarding & Scannability:** Restructured README to prioritize quick setup and clear usage steps, added a table of contents, and moved detailed environment variable and architectural reference material into collapsible `<details>` blocks.

### Refactored

- **Credential Handling & Import Cleanup:** Consolidated credential source definitions into a dedicated `CredentialSource` enum for improved type safety and consistency across auth modules. Streamlined imports, refined system credential policy helpers, and removed unused legacy code.

## [1.4.14] - 2026-08-15

### Fixed

- **`Connect message exceeds 67108864 bytes` recurring on every turn of a long-running conversation.** The upstream checkpoint Cursor hands back each turn was replayed into every request with no size cap, unlike the rest of the pipeline (tool results, blobs). Once it grew past the transport's 64 MiB frame limit, every later turn failed permanently. It is now discarded and rebuilt from the (already-bounded) blob store once it exceeds 48 MiB.
- Both the outgoing and incoming Connect-frame size errors now report the actual byte count, direction, and where to look (`/cursor.doctor`'s `lastRequestSize`, or `PI_CURSOR_PROVIDER_DEBUG=1`) instead of a bare byte limit.
- `sanitizeText()` no longer mangles valid Unicode surrogate pairs (emoji, astral-plane characters) — it now strips only lone/unpaired surrogates.
- `buildSelectedContextBlob()` now varint-encodes field lengths instead of writing a single raw length byte, preventing silent wire corruption if a future caller passes a value >=128 bytes.
- `/cursor.usage` no longer throws on a non-numeric billing-cycle timestamp from Cursor's usage endpoint.

## [1.4.13] - 2026-08-15

### Fixed

- **Whole-project reviews failing with `Connect message exceeds 67108864 bytes`.** Individual tool text results are now capped at 512 KiB, with an explicit truncation notice that tells the agent to retry with a narrower command or range.
- Tool images are bounded to a 16 MiB per-result budget, preventing a single oversized result from exhausting the bridge while retaining smaller images that fit.
- Oversized tool payloads are normalized before journaling and are no longer copied into debug logs, reducing memory, disk, and follow-up token usage.

## [1.4.12] - 2026-08-15

### Fixed

- **Pi host process exits during rapid tool chains.** Child-process spawn errors, pipe errors, malformed frames, and exceptions from bridge data/close consumers are now contained as request-level bridge failures instead of escaping Node event callbacks and terminating Pi.
- Bridge output that arrives before the stream consumer is registered is buffered with a hard size limit instead of being silently dropped.
- Added regression coverage for `EAGAIN`-style spawn failures, callback exceptions, oversized frames, and early bridge output.

## [1.4.11] - 2026-08-15

### Fixed

- **Excessive token usage on conversational prompts.** Trivial greetings and capability questions now omit both MCP tools and the large agent system prompt, while actionable requests retain the full context.
- `/cursor.doctor` now reports the actual lifecycle log path.

## [1.4.10] - 2026-08-15

### Fixed

- Hardened permission handling, transport framing, OAuth cancellation, recovery journals, logging, and MCP tool validation.
- Startup model discovery now uses stale-while-revalidate behavior so Pi can activate from cached or bundled models without waiting for network discovery.
- Added bounded payloads, backpressure handling, cleanup on aborted/failing streams, and expanded regression coverage.

## [1.4.9] - 2026-08-12

### Fixed

- **Tool continuation recovery after a silent resumed bridge.** Idle-timeout, abort, and transport-retry persistence now retain the mid-pause checkpoint and pending tool-call metadata when a tool result is being resumed, preventing valid checkpoints from being discarded as stale after the 3-minute watchdog fires.
- Added a recovery guard that refuses to replay tool results into a checkpoint when no matching durable mid-pause snapshot exists.

## [1.4.8] - 2026-08-02

### Fixed

- **`stale_checkpoint` error after tool calls when the bridge is lost.** Root cause traced via the durable journal: `commitStoredCheckpoint` records `checkpointTurnCount = completedTurns + 1` (it includes the just-finished turn). When a tool-result recovery request arrives, `turns.length` is still the pre-tool count (one less), so `discardStaleCheckpointIfNeeded` treated the valid checkpoint as stale, cleared both the checkpoint and mid-pause metadata, and left `planRecovery` with nothing to work with. The staleness check now allows the off-by-one when `midPause` metadata confirms the request is a tool continuation for that exact turn — the checkpoint is preserved for `planRecovery` to use.

## [1.4.7] - 2026-08-02

### Fixed

- **Pi Lens automated context displaced the real user prompt.** Messages explicitly labeled `[pi-lens automated context — not a user request]` (and other `[pi-lens automated …]` variants) were not recognized as provider infrastructure. When appended after `hi`, Pi Cursor treated `hi` as history and the Pi Lens file-safety notice as the active task, causing replies such as “I'll re-read tests/request-size.test.ts before editing it.” These notices now move into `<provider_context>` while the actual user text remains the live turn.
- Handles both separate-message and concatenated forms (`hi\n\n[pi-lens automated …]`) with regression coverage derived from the durable journal payload.

## [1.4.6] - 2026-08-02

### Fixed

- **Trivial conversational turns no longer send tool schemas.** Exact greetings and acknowledgements such as `hi`, `hello`, `thanks`, and `sounds good` cannot require repository/MCP tools, yet previously paid for all 48 contracts. These turns now omit tools entirely; actionable text such as `hi, inspect src` still receives the full compact tool surface.
- Adds a `tools_omitted` lifecycle event with the original tool count. On the measured 48-tool `hi` request this should reduce estimated input from ~16.7k tokens to ~8.5k (roughly 10% → 5% for the current model). The remaining floor is Pi's system/project prompt.

## [1.4.5] - 2026-08-02

### Fixed

- **Further reduced simple-turn context usage.** Cursor's protobuf `google.protobuf.Value` encoding amplifies verbose JSON Schema annotations. Slim mode now removes parameter-level descriptions and other annotation-only fields while preserving the executable tool contract: property names, types, required fields, unions, enums, and validation constraints. Function descriptions are reduced to one concise sentence. Synthetic verbose-tool payloads shrink by about 83%.
- Corrected `/cursor.doctor`'s `approxTokens` estimate. It previously double-counted tool schemas and system content already included in request/blob bytes. It now estimates from actual wire bytes only and reports `wireBytes` explicitly.

## [1.4.4] - 2026-08-02

### Fixed

- **Simple turns looked like they "used 20% context".** The visible context-mode hierarchy blurb is tiny; the real cost is Pi's system prompt + full tool/MCP JSON schemas (often tens of thousands of tokens) re-sent every turn. pi-cursor now:
  - drops no-op context-mode injections (hierarchy boilerplate + empty/mode-only `<session_state>`)
  - slims tool descriptions/parameter docs/enums before building Cursor MCP tool defs (**default on**; `PI_CURSOR_SLIM_TOOLS=0` to disable)
  - records a request-size breakdown on every stream (`lifecycle` `request_size` + `/cursor.doctor` `lastRequestSize`)

## [1.4.3] - 2026-08-02

### Fixed

- **Context-mode / compaction injections swallowed the real user message.** When Pi appended `context-mode active…` / `<session_state>` to the same user turn as the actual prompt (e.g. `hi\n\ncontext-mode active…`), the whole turn was classified as side-channel and folded into the system prompt — leaving an empty user task. Models then answered the prior session summary ("I'll re-read those three files…") instead of the new message. Mixed messages are now split: infrastructure blocks move to `<provider_context>`, and the residual user text stays as the live turn. Priority framing also states that the latest user message is the only task.

## [1.4.2] - 2026-08-02

### Fixed

- **npm publish CI failed with E403 after a manual publish.** The tag workflow always ran `npm publish`, so when a version was already on the registry it failed the release job. Publish now skips cleanly if `${name}@${version}` already exists, and asserts the git tag matches `package.json`.

## [1.4.1] - 2026-08-02

### Fixed

- **Long sessions dying with bridge/idle timeouts.** After partial assistant output, transport loss (GOAWAY, bridge crash, silence) previously hard-failed because blind retries were blocked to avoid duplicated text. Recovery now continues from the latest upstream **checkpoint** even when text/thinking already streamed — Cursor resumes server-side state and emits only new tokens, which Pi appends.
- **H2 activity idle default no longer kills healthy long runs.** `PI_CURSOR_H2_IDLE_TIMEOUT_MS` defaults to `0` (disabled). Parent heartbeats already keep the bridge alive; the previous 15-minute default was a common mid-session `Bridge connection lost` source.
- **Parked tool bridges no longer expire from the original park timestamp alone.** Heartbeats slide the active-bridge TTL forward during multi-round tool chains.
- **Vague `Bridge connection lost` errors.** Failures are classified (GOAWAY / reset / auth / timeout / crash) with retryability and actionable hints.

### Added

- **Durable run journal** (`src/stream/run-journal.ts`) under the pi-cursor cache dir. Checkpoints, mid-pause tool metadata, and referenced blobs survive bridge death so tool continuation / checkpoint resume can hydrate after a lost in-memory map.
- **Transport failure classifier** (`src/stream/transport-errors.ts`) and checkpoint-continuation prompt used by the stream runtime.
- Bridge handles expose `lastStderr()` for diagnostics.
- Unit coverage in `tests/transport-recovery.test.ts` for recovery policy, failure classification, timeout defaults, and journal round-trip.

### Changed

- Stream silence watchdog defaults: `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS` / `PI_CURSOR_RESUME_IDLE_TIMEOUT_MS` → **180000 (3 min)**; `PI_CURSOR_STREAM_IDLE_MAX_RETRIES` → **5**.
- Docs (README, AGENTS, protocol) aligned with the real runtime defaults.

## [1.4.0] - 2026-07-29

### Fixed

- **Extension initialization took 10–15 seconds.** Activation now completes in **3–12ms** (measured; previously ~6.8s of blocking work before pi could continue). Three independent causes, all on the critical path:
  - **A doomed token refresh on every launch (~2.6s).** The credential cascade tried the macOS Keychain first and, finding the Cursor CLI's access token expired, POSTed a refresh that could never succeed — the CLI writes the _same expired token_ into `cursor-refresh-token`, so `exchange_user_api_key` answers `Invalid User API Key` — before falling through to the Cursor IDE database, which resolved in 2ms. Both system sources are now read concurrently and every locally stored token is checked before any network exchange, so a valid token is never two milliseconds away behind a failing one. Resolution: **2762ms → 214ms**.
  - **Blocking model discovery (~4s).** `await discoverStartupModels()` ran two unary RPCs before the provider was registered at all. Discovery moved to pi's `refreshModels(context)` hook, which pi calls in the background and again whenever `/model` is opened; `allowNetwork:false` and aborted signals return the current rows without touching the network.
  - **Nothing survived the process.** The model cache was in-memory with a 5-minute TTL, so every new pi process re-paid full discovery. The catalog is now persisted to disk and read synchronously at startup.
- v1.3.4 added the startup `await` specifically so the full live catalog (Grok, Luna, Kimi) was registered upfront. That still holds — the persisted catalog means launches register the real discovered list (147 models here), not the bundled fallback — but it no longer costs a blocking round-trip.

### Added

- **Persistent model catalog cache** (`src/stream/model-cache.ts`) at `$XDG_CACHE_HOME/pi-cursor` (override with `PI_CURSOR_CACHE_DIR`). Stores the raw Cursor model shapes rather than pi `ModelConfig` rows, because the effort/max-mode routing `streamSimple` depends on does not survive that conversion. Version-stamped, 30-day max age, and tolerant of a corrupt or unwritable cache.
- **Refresh back-off** (`src/auth/refresh-guard.ts`). A refresh token that fails is remembered for 10 minutes and not retried, so a permanently-stale Cursor CLI keychain entry costs nothing on subsequent launches. The back-off is disk-backed and survives restarts; only a SHA-256 prefix is stored, never the token.
- **In-process HTTP/2 for unary RPCs** (`src/client/h2-unary.ts`). Model discovery no longer spawns a child process per call, saving ~1.5s of local overhead across the two RPCs. The h2-bridge subprocess still carries the bidirectional chat stream, where Bun's `node:http2` is unusable, and remains the automatic fallback if the in-process client fails. Force the old path with `PI_CURSOR_UNARY_BRIDGE=1`.
- `/cursor.doctor` reports `catalogCache`, `catalogCacheDir`, and `unaryTransport`.

### Changed

- `PI_OFFLINE` now skips live model discovery entirely rather than only skipping it at startup.
- `tokenSource` starts as `none` and fills in on the first stream or background refresh, since activation no longer resolves a credential. A `/cursor.doctor` run in the first second of a session may show `tokenSource=none`.

## [1.3.2] - 2026-07-26

### Fixed

- **`No API provider registered for api: cursor-native`.** The native transport was only attached via `pi.registerProvider({ streamSimple })`. Pi's Agent still dispatches through the global compat `streamSimple` registry on some hosts/entry paths, and ModelRuntime falls back to that same registry for custom `model.api` values. The extension now also calls `registerApiProvider({ api: "cursor-native", ... })` and stamps `api: "cursor-native"` on every model config so the dispatcher can find the stream implementation.

## [1.3.1] - 2026-07-25

### Fixed

- **Tool continuation was unrecoverable after the first tool round.** Losing the upstream bridge mid-tool failed with `Cursor tool continuation was lost … skipReason=pending_tool_call_mismatch` on every round after the first. The mid-pause snapshot records only the round that was parked, but the client re-sends every tool result in the in-flight user turn, and recovery demanded the two sets be equal. The parked set must instead be _covered by_ what arrived; the in-flight turn is still matched exactly, which is what pins the replayed transcript to the client's view.
- **Parallel tool calls beyond the first never reached the client.** Cursor can frame several execs in one chunk, but the response was closed on the first, so the rest were silently dropped and only re-offered if the bridge happened to survive. The pause is now deferred to the end of the chunk. Only execs the client was actually told about are recorded as pending, since recovery can only expect back what the client saw.
- **Checkpoints delivered during a tool pause were discarded.** The latest checkpoint was held in per-round state while the bridge outlived the round, so anything arriving mid-pause was stranded in the previous round's closure — a recurring cause of `hadStoredCheckpoint=false` diagnostics. It now lives on the bridge.
- **An oversized or unsupported image broke every later turn.** The whole history is re-parsed on each request and an image failing Cursor's 5 MiB / format check threw, so one bad screenshot — typically from a tool result — permanently failed the conversation. Images already in the transcript are now decoded leniently; the message being sent still errors, since that one the caller can fix.
- **An undecodable checkpoint was never discarded**, failing every subsequent turn in the conversation. It is now decoded once during staleness validation and dropped on failure, degrading to a rebuild.
- **The most load-bearing blob was first to be evicted.** `trimBlobStore` drops oldest-first, but merging used `Map.set`, which leaves an existing key at its original position — so the system-prompt blob, written first on every build and referenced by every checkpoint, was permanently the oldest entry. Merging now re-inserts, making eviction genuinely least-recently-referenced.
- **Tool-result images were dropped on checkpoint recovery**, though the full-history rebuild path preserved them.
- Tool results with no `tool_call_id` are excluded from recovery's set matching instead of reading as duplicates and failing an otherwise sound recovery.
- A live bridge is no longer resumed when the request's history does not match the one it was parked on. Without a Pi session id the bridge key is only a hash of the opening user message, so two conversations that start alike shared a key.

## [1.3.0] - 2026-07-24

### Added

- **Wire-drift detection.** Unrecognized `agent.v1` server messages and unknown protobuf fields are no longer skipped silently. They are counted, written to the lifecycle log as `wire_drift`, appended to the failing turn's error message, and listed by `/cursor.doctor` (`lastDriftSignal`, `wireDrift`, `wireDriftStranding` plus a detail block). `wireDriftStranding=yes` distinguishes an unanswered message that could have parked the turn from a merely out-of-date schema — previously both surfaced as a bare idle timeout.
- **Reproducible protobuf codegen.** `proto/agent.proto` is now vendored as the source of truth for `src/proto/agent_pb.ts`, with `npm run proto:gen` (regenerate), `npm run proto:sync` (recover the `.proto` from an updated generated file — protoc-gen-es embeds the full descriptor), and `npm run proto:check` (fails the build when the two drift apart, and is part of `npm run check`). Uses `buf` + `protoc-gen-es` from devDependencies, so no system `protoc` is required. See [`proto/README.md`](proto/README.md).
- `npm run smoke:wire` performs the real Connect/HTTP2 handshake against the configured endpoint and reports schema drift without starting a chat turn.

### Changed

- **`src/stream/native-core.ts` split into focused modules** (5,696 → ~1,650 lines): `types`, `tuning`, `debug-log`, `images`, `model-discovery`, `message-parsing`, `pi-adapter`, `request-build`, `bridge-session`, `session-state`, `server-messages`, `thinking-filter`, and `drift`. The public surface of `src/stream/index.ts` is unchanged.
- `native-core.ts` is now covered by ESLint and Prettier (it was previously exempted for being too large), which removed a large amount of dead code and unused imports.
- Shared structural types are declared once in `src/stream/types.ts`; `recovery.ts` and `native-core.ts` previously carried duplicate copies of `ParsedTurn`, `StoredConversation`, and friends.

### Removed

- **The quarantined OpenAI-compatible local proxy.** `startProxy`/`stopProxy` and the entire parallel request path (`handleChatCompletion`, `writeSSEStream`, `handleToolResultResume`, `handleNonStreamingResponse`, and helpers) are gone — roughly 1,250 lines that were unreachable from the provider. Native `streamSimple` was already the only chat path; `/cursor.doctor` now reports `proxyPath=removed`.

## [1.2.3] - 2026-07-24

### Fixed

- **Permanent hang guard.** A stream that receives no upstream progress of any kind now recovers/retries or ends the turn with a clear error instead of parking forever. Since 1.2.1 disabled the idle watchdog by default, any un-answered exec or silent/dropped upstream left the run "stuck on working" indefinitely (observed: a turn parked ~26 min until manually aborted). The watchdog is re-enabled by default as a **silence** guard: `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS` / `PI_CURSOR_RESUME_IDLE_TIMEOUT_MS` default to `120000` (2 min) and `PI_CURSOR_STREAM_IDLE_MAX_RETRIES` to `2`. Every server signal (text/thinking/token deltas, tool-call events, thinkingCompleted, heartbeat, summary, answered interaction/exec) counts as progress and resets it, and it is paused during tool execution — so long reasoning turns and slow tools are unaffected; it only fires on a genuine park. Set the env vars to `0` to restore the previous unbounded behavior.

### Added

- `execServerMessage` handling is now recorded in the lifecycle log (`exec_server {execCase, handled}` for non-tool execs) and an unanswered exec sets `lastStreamEvent=exec_unanswered:<case>`. Previously exec messages were invisible in the lifecycle log — the blind spot behind unexplained mid-run stalls.

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
