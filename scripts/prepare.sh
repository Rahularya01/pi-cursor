#!/bin/sh
# Build dist/ for git installs. Bootstrap Bun only when it is missing.
set -e
cd "$(dirname "$0")/.."

bun_version=$(sed -n 's/^[[:space:]]*"packageManager": "bun@\([^"]*\)".*/\1/p' package.json)
if [ -z "$bun_version" ]; then
  echo "pi-cursor: could not read packageManager bun version from package.json" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  bun_home="${BUN_INSTALL:-$HOME/.bun}/bin"
  if [ -x "$bun_home/bun" ]; then
    PATH="$bun_home:$PATH"
  else
    echo "pi-cursor: Bun not found; installing bun@$bun_version"
    curl -fsSL https://bun.sh/install | bash -s "bun-v$bun_version"
    PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
  fi
  export PATH
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "pi-cursor: Bun $bun_version is required to build. Install it from https://bun.sh and retry." >&2
  exit 1
fi

exec bun run build
