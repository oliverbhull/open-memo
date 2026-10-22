#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${1:?Pass the path to Memo.app}"
RESOURCES="${APP_DIR}/Contents/Resources"
bash "$(dirname "$0")/verify-conomo-bundle.sh" "${RESOURCES}/conomo"
bash "$(dirname "$0")/verify-pnc-bundle.sh" "${RESOURCES}/pnc"
echo 'Packaged Conomo and punctuation workers are ready.'
