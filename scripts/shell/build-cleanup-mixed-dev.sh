#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLEANUP_PYTHON="${MEMO_CLEANUP_PYTHON:-${ROOT_DIR}/.build/transcript-cleanup-dataset/mlx-env/bin/python}"
REFERENCE_MODEL="${MEMO_CLEANUP_BF16_REFERENCE:-${ROOT_DIR}/.build/transcript-cleanup-dataset/experiments/lfm2.5-1.2b-lora-v1/hybrid-v5/fused-step-1024-bf16-reference}"
CALIBRATION_DATA="${MEMO_CLEANUP_CALIBRATION_DATA:-${ROOT_DIR}/.build/transcript-cleanup-dataset/experiments/lfm2.5-1.2b-lora-v1/hybrid-v5/data/train.jsonl}"
OUTPUT_MODEL="${MEMO_CLEANUP_MIXED_MODEL:-${ROOT_DIR}/.build/transcript-cleanup-dataset/experiments/lfm2.5-1.2b-lora-v1/hybrid-v5/fused-step-1024-mixed-4-6}"
SENSITIVITIES="${OUTPUT_MODEL}.sensitivities.json"

if [[ ! -x "${CLEANUP_PYTHON}" ]]; then
  echo "Missing cleanup Python: ${CLEANUP_PYTHON}" >&2
  exit 1
fi
if [[ ! -f "${REFERENCE_MODEL}/model.safetensors" ]]; then
  echo "Missing fused BF16 cleanup reference: ${REFERENCE_MODEL}" >&2
  exit 1
fi
if [[ -e "${OUTPUT_MODEL}" ]]; then
  echo "Refusing to overwrite cleanup candidate: ${OUTPUT_MODEL}" >&2
  exit 1
fi

export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
"${CLEANUP_PYTHON}" "${ROOT_DIR}/scripts/python/build_cleanup_mixed_quant.py" \
  --model "${REFERENCE_MODEL}" \
  --calibration-data "${CALIBRATION_DATA}" \
  --output "${OUTPUT_MODEL}" \
  --sensitivities "${SENSITIVITIES}" \
  --samples "${MEMO_CLEANUP_CALIBRATION_SAMPLES:-32}" \
  --sequence-length "${MEMO_CLEANUP_CALIBRATION_SEQUENCE_LENGTH:-128}" \
  --target-bpw "${MEMO_CLEANUP_TARGET_BPW:-5.0}"
