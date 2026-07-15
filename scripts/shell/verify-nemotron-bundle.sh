#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_DIR="${1:-${ROOT_DIR}/.build/nemotron}"
PYTHON_BIN="${BUNDLE_DIR}/runtime/bin/python3.12"
WORKER="${BUNDLE_DIR}/memo_nemotron.py"
MODEL_DIR="${BUNDLE_DIR}/model"

for required in \
  "${PYTHON_BIN}" \
  "${WORKER}" \
  "${MODEL_DIR}/genai_config.json" \
  "${MODEL_DIR}/encoder.onnx" \
  "${MODEL_DIR}/encoder.onnx.data" \
  "${MODEL_DIR}/decoder.onnx" \
  "${MODEL_DIR}/decoder.onnx.data" \
  "${MODEL_DIR}/joint.onnx" \
  "${MODEL_DIR}/joint.onnx.data" \
  "${MODEL_DIR}/tokenizer.json" \
  "${MODEL_DIR}/model_config.json" \
  "${MODEL_DIR}/.memo-model-revision" \
  "${BUNDLE_DIR}/VERSIONS"; do
  if [[ ! -e "${required}" ]]; then
    echo "Nemotron bundle is missing ${required}" >&2
    exit 1
  fi
done

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "Bundled Python is not executable: ${PYTHON_BIN}" >&2
  exit 1
fi

PYTHONNOUSERSITE=1 "${PYTHON_BIN}" -c \
  'import numpy, onnxruntime_genai; print("Nemotron runtime imports OK")'
WORKER_OUTPUT="$(PYTHONNOUSERSITE=1 "${PYTHON_BIN}" "${WORKER}" \
  --model-path "${MODEL_DIR}" --worker < /dev/null)"
if [[ "${WORKER_OUTPUT}" != *"READY"* ]]; then
  echo "Nemotron worker did not load the packaged model: ${WORKER_OUTPUT}" >&2
  exit 1
fi
echo "Nemotron packaged model loads OK"
echo "Nemotron bundle verified at ${BUNDLE_DIR}"
