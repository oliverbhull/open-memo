#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${MEMO_BLE_OUTPUT_DIR:-${ROOT_DIR}/.build/ble}"
mkdir -p "${OUTPUT_DIR}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "memo-ble-bridge requires macOS/CoreBluetooth" >&2
  exit 1
fi

xcrun swiftc \
  -O \
  -framework CoreBluetooth \
  -framework Foundation \
  "${ROOT_DIR}/sidecars/ble-bridge/main.swift" \
  -o "${OUTPUT_DIR}/memo-ble-bridge"
chmod 755 "${OUTPUT_DIR}/memo-ble-bridge"
echo "memo-ble-bridge ready at ${OUTPUT_DIR}/memo-ble-bridge"
