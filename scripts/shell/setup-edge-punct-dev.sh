#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${MEMO_EDGE_PNC_DIR:-${ROOT_DIR}/.build/edge-punct-casing}"
SOURCE_DIR="${OUTPUT_DIR}/source"
MODEL_DIR="${OUTPUT_DIR}/model"
VENV_DIR="${OUTPUT_DIR}/venv"
REPOSITORY="frankyoujian/Edge-Punct-Casing"
REVISION="bde453bde24b544f38ffdd56398bfadcd22ce935"
ARCHIVE="${SOURCE_DIR}/sherpa-onnx-cnn-bilstm-unigram-bpe-en.7z"
ARCHIVE_SHA256="f21cb639bf3260c07afa5b87b7c986440cfbd1b6c08c4bbeb1fc16f020c8920c"
MODEL_SHA256="9d611f445fe4a46186080fe161be6059d87d72eb88d3a8cb00c1a06e83a6067e"
VOCAB_SHA256="e118b7ad88c54db562517df49e1cffd4836d166c34fb190fd311d7f34eb238f5"

command -v hf >/dev/null || { echo "hf is required to download Edge-Punct-Casing" >&2; exit 1; }
command -v 7z >/dev/null || { echo "7z is required to extract Edge-Punct-Casing" >&2; exit 1; }
command -v uv >/dev/null || { echo "uv is required to create the local runtime" >&2; exit 1; }
mkdir -p "${SOURCE_DIR}" "${MODEL_DIR}"

if [[ ! -f "${ARCHIVE}" ]] || [[ "$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')" != "${ARCHIVE_SHA256}" ]]; then
  hf download "${REPOSITORY}" \
    --revision "${REVISION}" \
    --include "$(basename "${ARCHIVE}")" \
    --local-dir "${SOURCE_DIR}"
fi
[[ "$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')" == "${ARCHIVE_SHA256}" ]] || { echo "Edge-Punct-Casing archive checksum mismatch" >&2; exit 1; }

if [[ ! -f "${MODEL_DIR}/model.int8.onnx" ]] || \
   [[ "$(shasum -a 256 "${MODEL_DIR}/model.int8.onnx" | awk '{print $1}')" != "${MODEL_SHA256}" ]] || \
   [[ ! -f "${MODEL_DIR}/bpe.vocab" ]] || \
   [[ "$(shasum -a 256 "${MODEL_DIR}/bpe.vocab" | awk '{print $1}')" != "${VOCAB_SHA256}" ]]; then
  7z e -y "${ARCHIVE}" -o"${MODEL_DIR}" '*/model.int8.onnx' '*/bpe.vocab' >/dev/null
fi
[[ "$(shasum -a 256 "${MODEL_DIR}/model.int8.onnx" | awk '{print $1}')" == "${MODEL_SHA256}" ]] || { echo "Edge-Punct-Casing model checksum mismatch" >&2; exit 1; }
[[ "$(shasum -a 256 "${MODEL_DIR}/bpe.vocab" | awk '{print $1}')" == "${VOCAB_SHA256}" ]] || { echo "Edge-Punct-Casing vocabulary checksum mismatch" >&2; exit 1; }

if ! "${VENV_DIR}/bin/python" -c 'import sherpa_onnx; assert sherpa_onnx.__version__ == "1.13.8"' 2>/dev/null; then
  uv venv "${VENV_DIR}" --python 3.12 --clear
  uv pip install --python "${VENV_DIR}/bin/python" sherpa-onnx==1.13.8 --no-progress
fi

OUTPUT="$(printf '%s\n' '{"id":"verify","text":"how are you i am fine thank you"}' | \
  "${VENV_DIR}/bin/python" "${ROOT_DIR}/scripts/python/edge-punct-worker.py" \
    --model-path "${MODEL_DIR}/model.int8.onnx" \
    --vocabulary-path "${MODEL_DIR}/bpe.vocab" \
    --worker)"
[[ "$(printf '%s\n' "${OUTPUT}" | head -n 1)" == READY ]] || { echo "Edge-Punct-Casing worker did not become ready" >&2; exit 1; }
[[ "$(printf '%s\n' "${OUTPUT}" | tail -n 1 | jq -r .text)" == "How are you? I am fine. Thank you." ]] || { echo "Edge-Punct-Casing returned unexpected text" >&2; exit 1; }

echo "Edge-Punct-Casing development runtime is ready at ${OUTPUT_DIR}"
echo "Edge-Punct-Casing will be selected by npm run dev"
