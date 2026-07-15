#!/usr/bin/env bash

set -euo pipefail

BUILD_TYPE="${1:-unsigned}"

case "$BUILD_TYPE" in
  unsigned)
    npm run build:dir
    ;;
  signed)
    npm run dist:mac
    ;;
  *)
    echo "Usage: $0 [unsigned|signed]" >&2
    exit 2
    ;;
esac

APP_PATH="dist/mac-arm64/Memo.app"
test -d "$APP_PATH"
bash scripts/shell/verify-nemotron-bundle.sh "$APP_PATH/Contents/Resources/nemotron"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo "Production build verified at $APP_PATH"
echo "This script does not install the app or reset macOS permissions."
