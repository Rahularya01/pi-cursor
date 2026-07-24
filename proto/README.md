# Cursor agent wire schema

`agent.proto` is the reverse-engineered schema for Cursor's `agent.v1` service. It is the
**source of truth** for `src/proto/agent_pb.ts`, which is generated and must never be
hand-edited.

## Regenerating the TypeScript

```bash
npm run proto:gen     # proto/agent.proto -> src/proto/agent_pb.ts
npm run proto:check   # fails if src/proto/agent_pb.ts is stale (runs in npm run check)
```

Both use `buf` and `protoc-gen-es` from devDependencies, so no system `protoc` is needed.

## When Cursor changes the schema

Cursor can change the agent schema at any time. There are two ways to pick that up:

1. **You have an updated `.proto`.** Edit `agent.proto`, then `npm run proto:gen`.

2. **You only have an updated generated file** (the common case — the schema is recovered
   from a Cursor client build). Drop the new `agent_pb.ts` into `src/proto/`, then:

   ```bash
   npm run proto:sync    # rebuild agent.proto from the new generated file
   npm run proto:check   # prove the two now agree
   ```

   `proto:sync` works because `protoc-gen-es` embeds the complete `FileDescriptorProto`
   in its output, so the generated file carries the whole schema losslessly.
   `scripts/proto-descriptor.ts` decodes it and prints proto3 source.

## Scope of the printer

`scripts/proto-descriptor.ts` handles the subset this schema uses: messages, nested
types, enums, oneofs, proto3 `optional`, maps, reserved ranges, and services. It throws
rather than silently dropping anything outside that — imports, extensions, groups, field
defaults, and custom options are all rejected. If Cursor's schema ever grows one of
those, extend the printer; `proto:check` will catch the mismatch either way.
