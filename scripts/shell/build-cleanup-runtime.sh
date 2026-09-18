#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_RUNTIME="${MEMO_CLEANUP_BASE_RUNTIME:-${ROOT_DIR}/.build/conomo/device-runtime}"
OUTPUT_RUNTIME="${MEMO_CLEANUP_RUNTIME:-${ROOT_DIR}/.build/cleanup-runtime}"
REQUIREMENTS="${ROOT_DIR}/scripts/requirements-cleanup-runtime.txt"

if [[ ! -x "${BASE_RUNTIME}/bin/python" ]]; then
  echo "Missing portable base Python runtime: ${BASE_RUNTIME}" >&2
  exit 1
fi
if [[ -e "${OUTPUT_RUNTIME}" ]]; then
  echo "Refusing to overwrite cleanup runtime: ${OUTPUT_RUNTIME}" >&2
  exit 1
fi

cp -R "${BASE_RUNTIME}" "${OUTPUT_RUNTIME}"
uv pip install --offline --break-system-packages \
  --python "${OUTPUT_RUNTIME}/bin/python" \
  --requirement "${REQUIREMENTS}"

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  "${OUTPUT_RUNTIME}/bin/python" \
  "${ROOT_DIR}/scripts/python/transcript-cleanup-worker.py" --self-test

runtime_kib="$(du -sk "${OUTPUT_RUNTIME}" | awk '{print $1}')"
echo "Portable cleanup runtime ready: ${OUTPUT_RUNTIME} (${runtime_kib} KiB)"
