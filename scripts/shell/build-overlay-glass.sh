#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == "Darwin" ]] || exit 0
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="${ROOT_DIR}/sidecars/overlay-glass/main.swift"
OUTPUT="${ROOT_DIR}/.build/overlay-glass/memo-overlay-glass"
mkdir -p "$(dirname "$OUTPUT")"
if [[ ! -x "$OUTPUT" || "$SOURCE" -nt "$OUTPUT" || "${BASH_SOURCE[0]}" -nt "$OUTPUT" ]]; then
  xcrun swiftc -O -target "$(uname -m)-apple-macosx15.0" -framework AppKit "$SOURCE" -o "$OUTPUT"
fi
