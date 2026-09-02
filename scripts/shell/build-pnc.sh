#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${MEMO_PNC_OUTPUT_DIR:-${ROOT_DIR}/.build/pnc}"
SOURCE_DIR="${OUTPUT_DIR}/source"
EXTRACTED_DIR="${SOURCE_DIR}/extracted"
CHECKPOINT="${SOURCE_DIR}/punctuation_en_distilbert.nemo"
CONVERT_VENV="${ROOT_DIR}/.build/pnc-convert-venv"
MODEL_URL="https://api.ngc.nvidia.com/v2/models/nvidia/nemo/punctuation_en_distilbert/versions/1.0.0rc1/files/punctuation_en_distilbert.nemo"
MODEL_SHA256="1d60dff59c927ad7a5c266f915b1e5710332d224bdbd39fb08f1335e39dbe89a"
MLPACKAGE="${OUTPUT_DIR}/DistilBertPunctuation.mlpackage"
COMPILED_DIR="${OUTPUT_DIR}/compiled"
MANIFEST="${OUTPUT_DIR}/manifest.json"

command -v uv >/dev/null || { echo "uv is required to build PnC" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo "PnC Core ML requires macOS" >&2; exit 1; }
mkdir -p "${SOURCE_DIR}" "${OUTPUT_DIR}"

if [[ ! -f "${CHECKPOINT}" ]] || [[ "$(shasum -a 256 "${CHECKPOINT}" | awk '{print $1}')" != "${MODEL_SHA256}" ]]; then
  echo "Downloading pinned NVIDIA punctuation_en_distilbert@1.0.0rc1"
  curl -L --fail --show-error --output "${CHECKPOINT}.partial" "${MODEL_URL}"
  [[ "$(shasum -a 256 "${CHECKPOINT}.partial" | awk '{print $1}')" == "${MODEL_SHA256}" ]] || { echo "PnC checkpoint checksum mismatch" >&2; exit 1; }
  mv "${CHECKPOINT}.partial" "${CHECKPOINT}"
fi

mkdir -p "${EXTRACTED_DIR}"
tar -xf "${CHECKPOINT}" -C "${EXTRACTED_DIR}"

CONVERT_HASH="$(shasum -a 256 "${ROOT_DIR}/sidecars/pnc/requirements-convert.txt" "${ROOT_DIR}/scripts/python/convert-distilbert-pnc-coreml.py" "${EXTRACTED_DIR}/model_weights.ckpt" | shasum -a 256 | awk '{print $1}')"
if [[ ! -f "${OUTPUT_DIR}/.conversion-hash" ]] || [[ "$(cat "${OUTPUT_DIR}/.conversion-hash")" != "${CONVERT_HASH}" ]]; then
  uv venv "${CONVERT_VENV}" --python 3.12 --clear
  uv pip install --python "${CONVERT_VENV}/bin/python" --requirements "${ROOT_DIR}/sidecars/pnc/requirements-convert.txt" --no-progress
  rm -rf "${MLPACKAGE}" "${COMPILED_DIR}"
  "${CONVERT_VENV}/bin/python" "${ROOT_DIR}/scripts/python/convert-distilbert-pnc-coreml.py" \
    --checkpoint "${EXTRACTED_DIR}/model_weights.ckpt" --output "${MLPACKAGE}" --manifest "${MANIFEST}"
  mkdir -p "${COMPILED_DIR}"
  xcrun coremlcompiler compile "${MLPACKAGE}" "${COMPILED_DIR}"
  printf '%s\n' "${CONVERT_HASH}" > "${OUTPUT_DIR}/.conversion-hash"
fi

xcrun swiftc -O -framework Foundation -framework CoreML \
  "${ROOT_DIR}/sidecars/pnc/main.swift" -o "${OUTPUT_DIR}/memo-pnc"
chmod 755 "${OUTPUT_DIR}/memo-pnc"
cp "${EXTRACTED_DIR}/tokenizer.vocab_file" "${OUTPUT_DIR}/tokenizer.vocab"
cp "${ROOT_DIR}/sidecars/pnc/NOTICE.md" "${OUTPUT_DIR}/NOTICE.md"
printf '%s\n' \
  "model=nvidia/nemo/punctuation_en_distilbert" \
  "revision=1.0.0rc1" \
  "sha256=${MODEL_SHA256}" \
  "quantization=int8-linear-symmetric" > "${OUTPUT_DIR}/VERSIONS"
bash "${ROOT_DIR}/scripts/shell/verify-pnc-bundle.sh" "${OUTPUT_DIR}"
du -sh "${OUTPUT_DIR}/compiled" "${OUTPUT_DIR}/memo-pnc" "${OUTPUT_DIR}/tokenizer.vocab"
