#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:?Pass the path to Memo.app}"
RESOURCES="${APP_DIR}/Contents/Resources"
CONOMO="${RESOURCES}/conomo"
MODEL_DIR="$(find "${CONOMO}/compiled" -maxdepth 1 -type d -name '*.mlmodelc' | head -n 1)"
[[ -n "${MODEL_DIR}" ]] || { echo 'Conomo compiled model is missing' >&2; exit 1; }

READY="$(printf '' | env \
  MEMO_CONTEXTUAL_PYTHON="${CONOMO}/device-runtime/bin/python3.12" \
  MEMO_CONTEXTUAL_BROKER="${RESOURCES}/dictation/contextual-worker.py" \
  MEMO_CONTEXTUAL_NATIVE="${RESOURCES}/dictation/memo-conomo-contextual" \
  MEMO_ASR_MODEL_PATH="${MODEL_DIR}" \
  MEMO_ASR_TOKENIZER_PATH="${CONOMO}/tokenizer.json" \
  "${RESOURCES}/dictation/run-contextual-conomo" --worker)"
[[ "${READY}" == READY ]] || { echo "Conomo contextual worker did not become ready: ${READY}" >&2; exit 1; }

bash "$(dirname "$0")/verify-pnc-bundle.sh" "${RESOURCES}/pnc"
echo 'Packaged Conomo and punctuation workers are ready.'
