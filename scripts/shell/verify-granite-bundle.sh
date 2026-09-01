#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_DIR="${1:-${ROOT_DIR}/.build/granite}"
MODEL_DIR="$(find "${BUNDLE_DIR}/compiled" -maxdepth 1 -type d -name '*.mlmodelc' | head -n 1)"
for required in memo-granite-asr tokenizer.json manifest.json VERSIONS device-runtime/bin/python3.12; do
  [[ -e "${BUNDLE_DIR}/${required}" ]] || { echo "Granite bundle missing ${required}" >&2; exit 1; }
done
[[ -n "${MODEL_DIR}" ]] || { echo "Granite bundle missing compiled .mlmodelc" >&2; exit 1; }
[[ "$(jq -r .quantization "${BUNDLE_DIR}/manifest.json")" == int4 ]] || { echo "Granite manifest is not INT4" >&2; exit 1; }
[[ "$(jq -r .int4_operations "${BUNDLE_DIR}/manifest.json")" -gt 0 ]] || { echo "Granite manifest has no INT4 operations" >&2; exit 1; }
[[ -x "${BUNDLE_DIR}/memo-granite-asr" ]] || { echo "Granite worker is not executable" >&2; exit 1; }
"${BUNDLE_DIR}/device-runtime/bin/python3.12" -B -c 'import serial; print(serial.VERSION)' >/dev/null
READY="$(printf '' | "${BUNDLE_DIR}/memo-granite-asr" --model-path "${MODEL_DIR}" --tokenizer-path "${BUNDLE_DIR}/tokenizer.json" --worker | head -n 1)"
[[ "${READY}" == READY ]] || { echo "Granite worker did not become ready: ${READY}" >&2; exit 1; }
echo "Granite Core ML INT4 bundle verified at ${BUNDLE_DIR}"
