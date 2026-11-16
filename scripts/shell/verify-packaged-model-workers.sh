#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${1:?Pass the path to Memo.app}"
RESOURCES="${APP_DIR}/Contents/Resources"
PLIST="${APP_DIR}/Contents/Info.plist"
plutil -lint "${PLIST}" >/dev/null
for key in NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription; do
  if plutil -extract "${key}" raw -o - "${PLIST}" >/dev/null 2>&1; then
    echo "Unexpected Bluetooth usage description in Memo.app: ${key}" >&2
    exit 1
  fi
done
test ! -e "${RESOURCES}/device-sync"
bash "$(dirname "$0")/verify-conomo-bundle.sh" "${RESOURCES}/conomo"
bash "$(dirname "$0")/verify-pnc-bundle.sh" "${RESOURCES}/pnc"
"${RESOURCES}/conomo/device-runtime/bin/python3.12" -B "$(dirname "$0")/../python/verify_bundled_runtime_isolation.py" "${RESOURCES}/conomo"
echo 'Packaged Conomo and punctuation workers are ready.'
