#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == "Darwin" ]] || exit 0
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="${ROOT_DIR}/sidecars/browser-context/main.swift"
OUTPUT="${ROOT_DIR}/.build/browser-context/memo-browser-context"
mkdir -p "$(dirname "$OUTPUT")"
if [[ ! -x "$OUTPUT" || "$SOURCE" -nt "$OUTPUT" ]]; then
  xcrun swiftc -O -framework AppKit -framework ApplicationServices "$SOURCE" -o "$OUTPUT"
fi
