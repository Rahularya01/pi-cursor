# CLAUDE.md

This project's agent guidance lives in [AGENTS.md](./AGENTS.md) — read it first. It covers the
architecture, module layout, validation commands, auth cascade, and environment variables. This
file only adds notes specific to working here with Claude Code.

## Before finishing any task

Run `bun run check` (typecheck, lint, format:check, security-check, proto:check, bun test,
test:legacy). Fix any failure your change caused before reporting done.

## Things to keep in mind

- Native ESM: relative imports need explicit `.js` extensions even though the source is `.ts`.
- Never hand-edit `src/proto/agent_pb.ts` — change `proto/agent.proto` and run `bun run proto:gen`.
- Streaming transport (`src/client/h2-session.ts`) and unary transport (`src/client/h2-unary.ts`)
  are deliberately different code paths — see AGENTS.md §6 before "simplifying" them into one.
- Bun is the only supported runtime — no Node.js binary is required or spawned anywhere. All
  Cursor HTTP/2 transport runs in-process via `node:http2` (Bun implements it natively). `dist/`
  still builds with `target: "node"` to keep the bundle on portable APIs, but that's a build
  choice, not a runtime requirement — see AGENTS.md §7.
- Tokens and Authorization headers must go through `redactSecrets()`
  (`src/utils/security.ts`) before landing in logs, diagnostics, or error messages.
- No `node_modules/` is committed; run `bun install` before typecheck/build/test if the working
  tree is fresh.
