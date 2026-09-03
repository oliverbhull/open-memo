#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GRANITE_PYTHON="${MEMO_GRANITE_PYTHON:-/Users/oliverhull/models/asr/.venv-granite/bin/python}"
GRANITE_MODEL="${MEMO_GRANITE_MODEL:-/Users/oliverhull/models/asr/huggingface/granite-speech-5.0-470m-turboctc}"
TARGET_DIR="${ROOT_DIR}/.build/contextual-ctc-python"
NATIVE_WORKER="${MEMO_CONTEXTUAL_NATIVE:-${ROOT_DIR}/.build/contextual-granite-native}"

export PYTHONPATH="${TARGET_DIR}${PYTHONPATH:+:${PYTHONPATH}}"
exec "${GRANITE_PYTHON}" \
  "${ROOT_DIR}/experiments/contextual-ctc/app_worker.py" \
  --native "${NATIVE_WORKER}" \
  --model-path "${ROOT_DIR}/.build/conomo/compiled/GraniteSpeech.mlmodelc" \
  --tokenizer-path "${GRANITE_MODEL}/tokenizer.json" \
  "$@"
