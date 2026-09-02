#!/bin/sh
# Build dist/ for git installs. Bootstrap Bun only when it is missing.
set -e
cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  bun_home="${BUN_INSTALL:-$HOME/.bun}/bin"
  if [ -x "$bun_home/bun" ]; then
    PATH="$bun_home:$PATH"
  else
    echo "pi-cursor: Bun not found; installing from https://bun.sh"
    curl -fsSL https://bun.sh/install | bash
    PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
  fi
  export PATH
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "pi-cursor: Bun is required to build. Install it from https://bun.sh and retry." >&2
  exit 1
fi

exec bun run build
