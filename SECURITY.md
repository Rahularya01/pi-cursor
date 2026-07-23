# Security Policy

## Supported versions

Security fixes are applied to the latest published `1.x` release. Please upgrade to the latest version before reporting an issue.

## Reporting a vulnerability

Please **do not** open a public issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/Rahularya01/pi-cursor/security/advisories/new) to send a report directly to the maintainers. Include:

- a clear description and impact assessment;
- reproducible steps or a minimal proof of concept;
- affected versions and environment details; and
- a suggested remediation, if available.

We will acknowledge valid reports, investigate them privately, and coordinate a fix and disclosure. Do not include OAuth access tokens, refresh tokens, client secrets, or other credentials in your report.

## Scope

This repository contains a Pi extension that handles OAuth credentials and sends requests to Cursor Connect endpoints. Reports involving credential exposure, unsafe endpoint handling, OAuth callback validation, request construction, dependency vulnerabilities, or release automation are in scope.

## Access tokens & secrets

Treat access and refresh tokens in `~/.pi/agent/auth.json`, Keychain, or `state.vscdb` as sensitive. Do not share or commit session tokens.

### System credential reuse

By default, `pi-cursor` may read Cursor CLI Keychain items and Cursor IDE `state.vscdb` to reuse an existing login. Disable that behavior with:

```bash
export PI_CURSOR_SYSTEM_CREDENTIALS=0
```

When disabled, authenticate only via `/login cursor` or `CURSOR_ACCESS_TOKEN`.

### Agent URL allowlist

Custom agent URLs (`PI_CURSOR_AGENT_URL` / `CURSOR_AGENT_URL`) must use an allowed Cursor host (`*.cursor.sh` / `*.cursor.com` or localhost). This reduces token exfiltration risk from a poisoned base URL.
