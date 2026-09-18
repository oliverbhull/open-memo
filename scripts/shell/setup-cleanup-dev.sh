#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLEANUP_PYTHON="${MEMO_CLEANUP_PYTHON:-${ROOT_DIR}/.build/cleanup-runtime/bin/python}"
CLEANUP_MODEL="${MEMO_CLEANUP_MODEL:-${ROOT_DIR}/.build/models/LFM2.5-1.2B-Instruct-MLX-8bit}"
CLEANUP_ADAPTER="${MEMO_CLEANUP_ADAPTER:-${ROOT_DIR}/.build/transcript-cleanup-dataset/experiments/lfm2.5-1.2b-lora-v1/hybrid-v5/adapter-bf16}"
CLEANUP_CHECKPOINT="${MEMO_CLEANUP_CHECKPOINT:-${CLEANUP_ADAPTER}/0001024_adapters.safetensors}"
CLEANUP_WORKER="${ROOT_DIR}/scripts/python/transcript-cleanup-worker.py"
CLEANUP_FUSED_MODEL="${MEMO_CLEANUP_FUSED_MODEL:-${ROOT_DIR}/.build/transcript-cleanup-dataset/experiments/lfm2.5-1.2b-lora-v1/hybrid-v5/fused-step-1024-6bit}"
CLEANUP_USE_UNFUSED="${MEMO_CLEANUP_USE_UNFUSED:-0}"

missing=()
[[ -x "${CLEANUP_PYTHON}" ]] || missing+=("Python environment")
if [[ "${CLEANUP_USE_UNFUSED}" == "1" || ! -f "${CLEANUP_FUSED_MODEL}/model.safetensors" ]]; then
  [[ -f "${CLEANUP_MODEL}/model.safetensors" ]] || missing+=("8-bit LFM model")
  [[ -f "${CLEANUP_ADAPTER}/adapter_config.json" ]] || missing+=("adapter configuration")
  [[ -f "${CLEANUP_CHECKPOINT}" ]] || missing+=("step-1024 adapter checkpoint")
fi
[[ -f "${CLEANUP_WORKER}" ]] || missing+=("cleanup worker")

if (( ${#missing[@]} > 0 )); then
  printf 'Clean writing mode will be unavailable; missing local %s.\n' "$(IFS=', '; echo "${missing[*]}")" >&2
  exit 0
fi

"${CLEANUP_PYTHON}" "${CLEANUP_WORKER}" --self-test
echo "Local LFM cleanup assets passed the source check. Select Writing → Cleaned in the development app."
