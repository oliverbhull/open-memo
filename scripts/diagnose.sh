#!/usr/bin/env bash

set -u

APP_PATH="/Applications/Memo.app"
BINARY_PATH="$APP_PATH/Contents/Resources/sttbin/memo-stt"
USER_DATA="$HOME/Library/Application Support/Memo"

echo "Memo diagnostic (read-only)"
echo

if [[ ! -d "$APP_PATH" ]]; then
  echo "FAIL: Memo.app was not found at $APP_PATH"
  exit 1
fi
echo "PASS: application bundle exists"

if [[ ! -f "$BINARY_PATH" ]]; then
  echo "FAIL: memo-stt was not found at $BINARY_PATH"
  exit 1
fi
echo "PASS: memo-stt exists"

if [[ -x "$BINARY_PATH" ]]; then
  echo "PASS: memo-stt is executable"
else
  echo "FAIL: memo-stt is not executable"
fi

if codesign --verify --strict --verbose=2 "$BINARY_PATH" >/dev/null 2>&1; then
  echo "PASS: memo-stt signature is valid"
else
  echo "FAIL: memo-stt signature validation failed"
fi

if codesign --verify --deep --strict --verbose=2 "$APP_PATH" >/dev/null 2>&1; then
  echo "PASS: application signature is valid"
else
  echo "FAIL: application signature validation failed"
fi

if spctl --assess --type execute --verbose "$APP_PATH" >/dev/null 2>&1; then
  echo "PASS: Gatekeeper accepts the application"
else
  echo "WARN: Gatekeeper did not accept the application"
fi

if [[ -d "$USER_DATA" ]]; then
  echo "PASS: user data directory exists"
else
  echo "INFO: user data directory does not exist yet"
fi

if xattr -p com.apple.quarantine "$APP_PATH" >/dev/null 2>&1; then
  echo "INFO: application has a quarantine attribute"
else
  echo "INFO: application has no quarantine attribute"
fi

echo
echo "Recent logs: log show --predicate 'process == \"Memo\" OR process == \"memo-stt\"' --last 5m"
echo "This diagnostic did not modify the app, permissions, quarantine state, or user data."
