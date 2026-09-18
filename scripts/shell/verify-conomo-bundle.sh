#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_DIR="${1:-${ROOT_DIR}/.build/conomo}"

for required in conomo compiled tokenizer.json manifest.json LICENSE-APACHE-2.0.txt NOTICE.txt VERSIONS device-runtime/bin/python3.12; do
  [[ -e "${BUNDLE_DIR}/${required}" ]] || { echo "conomo bundle missing ${required}" >&2; exit 1; }
done
MODEL_COUNT="$(find "${BUNDLE_DIR}/compiled" -maxdepth 1 -type d -name '*.mlmodelc' | wc -l | tr -d ' ')"
[[ "${MODEL_COUNT}" == 1 ]] || { echo "conomo bundle must contain exactly one compiled Core ML model" >&2; exit 1; }
[[ "$(jq -r .quantization "${BUNDLE_DIR}/manifest.json")" == int4 ]] || { echo "conomo manifest is not INT4" >&2; exit 1; }
[[ "$(jq -r .int4_operations "${BUNDLE_DIR}/manifest.json")" -gt 0 ]] || { echo "conomo manifest has no INT4 operations" >&2; exit 1; }
[[ -x "${BUNDLE_DIR}/conomo" ]] || { echo "conomo is not executable" >&2; exit 1; }
"${BUNDLE_DIR}/device-runtime/bin/python3.12" -B -c 'import serial; print(serial.VERSION)' >/dev/null
READY="$(printf '' | "${BUNDLE_DIR}/conomo" --worker | head -n 1)"
[[ "${READY}" == READY ]] || { echo "conomo did not become ready: ${READY}" >&2; exit 1; }
echo "conomo bundle verified at ${BUNDLE_DIR}"
