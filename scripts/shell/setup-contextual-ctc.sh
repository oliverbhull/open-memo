#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GRANITE_PYTHON="${MEMO_GRANITE_PYTHON:-/Users/oliverhull/models/asr/.venv-granite/bin/python}"
GRANITE_MODEL="${MEMO_GRANITE_MODEL:-/Users/oliverhull/models/asr/huggingface/granite-speech-5.0-470m-turboctc}"
TARGET_DIR="${ROOT_DIR}/.build/contextual-ctc-python"
NATIVE_WORKER="${ROOT_DIR}/.build/contextual-granite-native"
COREML_MODEL="${ROOT_DIR}/.build/conomo/compiled/GraniteSpeech.mlmodelc"

[[ -x "${GRANITE_PYTHON}" ]] || { echo "Granite Python is missing: ${GRANITE_PYTHON}" >&2; exit 1; }
[[ -f "${GRANITE_MODEL}/model.safetensors" ]] || { echo "Granite model is missing: ${GRANITE_MODEL}" >&2; exit 1; }
[[ -f "${GRANITE_MODEL}/tokenizer.json" ]] || { echo "Granite tokenizer is missing: ${GRANITE_MODEL}/tokenizer.json" >&2; exit 1; }
[[ -d "${COREML_MODEL}" ]] || { echo "Compiled Granite Core ML model is missing: ${COREML_MODEL}" >&2; exit 1; }
command -v uv >/dev/null || { echo "uv is required to set up contextual CTC" >&2; exit 1; }

if [[ ! -f "${TARGET_DIR}/pyctcdecode/__init__.py" || ! -f "${TARGET_DIR}/pygtrie.py" ]]; then
  uv pip install \
    --python "${GRANITE_PYTHON}" \
    --target "${TARGET_DIR}" \
    --no-deps \
    pyctcdecode==0.5.0 pygtrie==2.6.1
fi

PYTHONPATH="${TARGET_DIR}${PYTHONPATH:+:${PYTHONPATH}}" \
  "${GRANITE_PYTHON}" "${ROOT_DIR}/experiments/contextual-ctc/prototype.py" \
  --model "${GRANITE_MODEL}" --self-test

if [[ ! -x "${NATIVE_WORKER}" || "${ROOT_DIR}/experiments/contextual-ctc/native_worker.swift" -nt "${NATIVE_WORKER}" ]]; then
  xcrun swiftc -O -framework Foundation -framework CoreML -framework Accelerate \
    "${ROOT_DIR}/experiments/contextual-ctc/native_worker.swift" \
    -o "${NATIVE_WORKER}"
  chmod 755 "${NATIVE_WORKER}"
fi

echo "Contextual Granite development worker is ready."
