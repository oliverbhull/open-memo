#!/usr/bin/env bash

set -euo pipefail

APP_PATH="/Applications/Memo.app"
USER_DATA="$HOME/Library/Application Support/Memo"
CACHE_DIR="$HOME/Library/Caches/com.memo.desktop"
LOG_DIR="$HOME/Library/Logs/Memo"
LEGACY_SETTINGS="$HOME/.memo-web-settings.json"

echo "This permanently removes Memo and all locally stored memos."
read -r -p "Type DELETE to continue: " confirm
if [[ "$confirm" != "DELETE" ]]; then
  echo "Removal cancelled."
  exit 0
fi

rm -rf "$APP_PATH" "$USER_DATA" "$CACHE_DIR" "$LOG_DIR"
rm -f "$LEGACY_SETTINGS" "$LEGACY_SETTINGS.backup"

echo "Memo and its local data were removed."
echo "macOS privacy entries can be reset separately with:"
echo "  tccutil reset Microphone com.memo.desktop"
echo "  tccutil reset ListenEvent com.memo.desktop"
echo "  tccutil reset Accessibility com.memo.desktop"
