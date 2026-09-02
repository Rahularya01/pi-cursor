#!/bin/sh
# Run prepare.mjs with Bun when present, otherwise Node (Pi git installs).
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
script="$root/scripts/prepare.mjs"

if command -v bun >/dev/null 2>&1; then
  exec bun "$script"
fi
if command -v node >/dev/null 2>&1; then
  exec node "$script"
fi

echo "pi-cursor: need Bun ${BUN_MIN:-1.4.0}+ or Node to build from source. Install Bun from https://bun.sh" >&2
exit 1
