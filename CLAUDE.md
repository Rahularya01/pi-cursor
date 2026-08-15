# CLAUDE.md

This project's agent guidance lives in [AGENTS.md](./AGENTS.md) — read it first. It covers the
architecture, module layout, validation commands, auth cascade, and environment variables. This
file only adds notes specific to working here with Claude Code.

## Before finishing any task

Run `npm run check` (typecheck, lint, format:check, security-check, proto:check, vitest,
test:legacy). Fix any failure your change caused before reporting done.

## Things to keep in mind

- Native ESM: relative imports need explicit `.js` extensions even though the source is `.ts`.
- Never hand-edit `src/proto/agent_pb.ts` — change `proto/agent.proto` and run `npm run proto:gen`.
- Streaming transport (`src/client/h2-bridge.mjs`) and unary transport (`src/client/h2-unary.ts`)
  are deliberately different code paths — see AGENTS.md §4.5 before "simplifying" them into one.
- Tokens and Authorization headers must go through `redactSecrets()`
  (`src/utils/security.ts`) before landing in logs, diagnostics, or error messages.
- No `node_modules/` is committed; run `npm install` before typecheck/build/test if the working
  tree is fresh.
