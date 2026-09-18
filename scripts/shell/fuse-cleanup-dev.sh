#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLEANUP_PYTHON="${MEMO_CLEANUP_PYTHON:-${ROOT_DIR}/.build/transcript-cleanup-dataset/mlx-env/bin/python}"
CLEANUP_MODEL="${MEMO_CLEANUP_MODEL:-${ROOT_DIR}/.build/models/LFM2.5-1.2B-Instruct-MLX-8bit}"
CLEANUP_ADAPTER="${MEMO_CLEANUP_ADAPTER:-${ROOT_DIR}/.build/transcript-cleanup-dataset/experiments/lfm2.5-1.2b-lora-v1/hybrid-v5/adapter-bf16}"
CLEANUP_CHECKPOINT="${MEMO_CLEANUP_CHECKPOINT:-${CLEANUP_ADAPTER}/0001024_adapters.safetensors}"
CLEANUP_FUSED_MODEL="${MEMO_CLEANUP_FUSED_MODEL:-${ROOT_DIR}/.build/transcript-cleanup-dataset/experiments/lfm2.5-1.2b-lora-v1/hybrid-v5/fused-step-1024-8bit}"
EXPECTED_CHECKPOINT_SHA256="cc7c264c86d43fd8ca7136cc7966e0e4bd580c2b16b2bfef3846acf67176fc76"

actual_sha256="$(shasum -a 256 "${CLEANUP_CHECKPOINT}" | awk '{print $1}')"
if [[ "${actual_sha256}" != "${EXPECTED_CHECKPOINT_SHA256}" ]]; then
  echo "Refusing to fuse unexpected cleanup checkpoint: ${actual_sha256}" >&2
  exit 1
fi

if [[ -e "${CLEANUP_FUSED_MODEL}" ]]; then
  echo "Fused cleanup model already exists: ${CLEANUP_FUSED_MODEL}"
  exit 0
fi

staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/memo-cleanup-adapter.XXXXXX")"
cleanup() {
  rm -rf "${staging_dir}"
}
trap cleanup EXIT

cp "${CLEANUP_ADAPTER}/adapter_config.json" "${staging_dir}/adapter_config.json"
cp "${CLEANUP_CHECKPOINT}" "${staging_dir}/adapters.safetensors"

"${CLEANUP_PYTHON}" -m mlx_lm fuse \
  --model "${CLEANUP_MODEL}" \
  --adapter-path "${staging_dir}" \
  --save-path "${CLEANUP_FUSED_MODEL}"

"${CLEANUP_PYTHON}" - "${CLEANUP_FUSED_MODEL}/memo-cleanup-fusion.json" \
  "${CLEANUP_MODEL}" "${CLEANUP_CHECKPOINT}" "${actual_sha256}" <<'PYJSON'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(json.dumps({
    "base_model": sys.argv[2],
    "adapter_checkpoint": sys.argv[3],
    "adapter_checkpoint_sha256": sys.argv[4],
    "dequantized": False,
}, indent=2) + "\n")
PYJSON

echo "Fused exact step-1024 cleanup model: ${CLEANUP_FUSED_MODEL}"
