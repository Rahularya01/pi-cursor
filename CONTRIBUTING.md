# Contributing

Thanks for improving `pi-cursor`.

## Before opening an issue

- Search existing issues first.
- Do not report security vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).
- Include the Pi version, package version, operating system, selected model, and sanitized `/cursor.doctor` output when reporting a bug.

## Development setup

Requires [Node.js](https://nodejs.org) >= 22 and [Yarn 4](https://yarnpkg.com) (Corepack: `corepack enable`).
All HTTP/2 transport runs in-process via `node:http2`.

```bash
yarn install
yarn check
```

`yarn check` runs TypeScript, ESLint, Prettier, the repository security checks, the
protobuf staleness check, and the unit tests. Run it before opening a pull request.

## Generated code

`src/proto/agent_pb.ts` is generated from `proto/agent.proto` — never edit it by hand.
Change the `.proto` and run `yarn proto:gen`; `yarn proto:check` fails the build if
the two drift apart. See [`proto/README.md`](proto/README.md), which also covers how to
recover the `.proto` when you only have an updated generated file from upstream.

## Pull requests

1. Fork the repository and create a focused branch.
2. Keep changes small and explain their user impact.
3. Add or update tests when behavior changes.
4. Update documentation when commands, authentication, configuration, or models change.
5. Ensure `yarn check` passes.

Do not include credentials, access tokens, refresh tokens, OAuth client secrets, or private account data in commits, issues, pull requests, or logs.

## Releases

Maintainers publish releases by pushing a version tag (`vX.Y.Z`). Contributors must not publish the package or modify release credentials.
