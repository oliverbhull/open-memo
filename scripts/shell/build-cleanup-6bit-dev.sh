#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLEANUP_PYTHON="${MEMO_CLEANUP_PYTHON:-${ROOT_DIR}/.build/transcript-cleanup-dataset/mlx-env/bin/python}"
REFERENCE_MODEL="${MEMO_CLEANUP_BF16_REFERENCE:-${ROOT_DIR}/.build/transcript-cleanup-dataset/experiments/lfm2.5-1.2b-lora-v1/hybrid-v5/fused-step-1024-bf16-reference}"
OUTPUT_MODEL="${MEMO_CLEANUP_6BIT_MODEL:-${ROOT_DIR}/.build/transcript-cleanup-dataset/experiments/lfm2.5-1.2b-lora-v1/hybrid-v5/fused-step-1024-6bit}"

if [[ ! -f "${REFERENCE_MODEL}/model.safetensors" ]]; then
  echo "Missing fused BF16 cleanup reference: ${REFERENCE_MODEL}" >&2
  exit 1
fi
if [[ -e "${OUTPUT_MODEL}" ]]; then
  echo "Refusing to overwrite cleanup candidate: ${OUTPUT_MODEL}" >&2
  exit 1
fi

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  "${CLEANUP_PYTHON}" -m mlx_lm convert \
  --hf-path "${REFERENCE_MODEL}" \
  --mlx-path "${OUTPUT_MODEL}" \
  --quantize --q-group-size 64 --q-bits 6

"${CLEANUP_PYTHON}" "${ROOT_DIR}/scripts/python/write_cleanup_model_manifest.py" \
  --model "${OUTPUT_MODEL}" \
  --candidate memo-lfm-hybrid-v5-step-1024-6bit \
  --precision affine-group64-6bit \
  --source-model "${REFERENCE_MODEL}" \
  --prompt "${ROOT_DIR}/scripts/python/cleanup_prompt.py"
