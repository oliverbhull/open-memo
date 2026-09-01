#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${MEMO_GRANITE_OUTPUT_DIR:-${ROOT_DIR}/.build/granite}"
MODEL_SOURCE="${MEMO_GRANITE_MODEL_SOURCE:-/Users/oliverhull/models/asr/huggingface/granite-speech-5.0-470m-turboctc}"
MODEL_REPO="ibm-granite/granite-speech-5.0-470m-turboctc"
MODEL_REVISION="18ca3c1de6cd092b5a30c39fb0f04550b38ed1a0"
MODEL_SHA256="8b98a8c34fd5fcb081caef719638eded31bb6d197d62053eefc5c1703aaf1ad4"
TOKENIZER_SHA256="3ee80b02f0119a040a70eb909c20fac8271c173d7e71d195a3b35f77780061e6"
SOURCE_DIR="${OUTPUT_DIR}/source"
CONVERT_VENV="${ROOT_DIR}/.build/granite-convert-venv"
DEVICE_INSTALL="${ROOT_DIR}/.build/granite-device-python-install"
DEVICE_RUNTIME="${OUTPUT_DIR}/device-runtime"
MLPACKAGE="${OUTPUT_DIR}/GraniteSpeech.mlpackage"
COMPILED_DIR="${OUTPUT_DIR}/compiled"
MANIFEST="${OUTPUT_DIR}/manifest.json"

command -v uv >/dev/null || { echo "uv is required to build Granite" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { echo "Granite Core ML requires macOS" >&2; exit 1; }
mkdir -p "${OUTPUT_DIR}"

if [[ ! -f "${MODEL_SOURCE}/model.safetensors" ]]; then
  echo "Downloading pinned ${MODEL_REPO}@${MODEL_REVISION}"
  rm -rf "${SOURCE_DIR}"
  uvx --from huggingface-hub==1.29.0 hf download "${MODEL_REPO}" --revision "${MODEL_REVISION}" --local-dir "${SOURCE_DIR}"
  MODEL_SOURCE="${SOURCE_DIR}"
fi
for required in model.safetensors config.json preprocessor_config.json tokenizer.json; do
  [[ -f "${MODEL_SOURCE}/${required}" ]] || { echo "Granite source missing ${required}" >&2; exit 1; }
done
[[ "$(shasum -a 256 "${MODEL_SOURCE}/model.safetensors" | awk '{print $1}')" == "${MODEL_SHA256}" ]] || { echo "Granite model checksum does not match pinned revision" >&2; exit 1; }
[[ "$(shasum -a 256 "${MODEL_SOURCE}/tokenizer.json" | awk '{print $1}')" == "${TOKENIZER_SHA256}" ]] || { echo "Granite tokenizer checksum does not match pinned revision" >&2; exit 1; }

CONVERT_HASH="$(shasum -a 256 "${ROOT_DIR}/sidecars/granite/requirements-convert.txt" "${ROOT_DIR}/scripts/python/convert-granite-coreml.py" "${MODEL_SOURCE}/model.safetensors" | shasum -a 256 | awk '{print $1}')"
if [[ ! -f "${OUTPUT_DIR}/.conversion-hash" ]] || [[ "$(cat "${OUTPUT_DIR}/.conversion-hash")" != "${CONVERT_HASH}" ]]; then
  uv venv "${CONVERT_VENV}" --python 3.12 --clear
  uv pip install --python "${CONVERT_VENV}/bin/python" --requirements "${ROOT_DIR}/sidecars/granite/requirements-convert.txt" --no-progress
  rm -rf "${MLPACKAGE}" "${COMPILED_DIR}"
  "${CONVERT_VENV}/bin/python" "${ROOT_DIR}/scripts/python/convert-granite-coreml.py" \
    --source "${MODEL_SOURCE}" --output "${MLPACKAGE}" --manifest "${MANIFEST}" --revision "${MODEL_REVISION}"
  mkdir -p "${COMPILED_DIR}"
  xcrun coremlcompiler compile "${MLPACKAGE}" "${COMPILED_DIR}"
  rm -rf "${MLPACKAGE}"
  printf '%s\n' "${CONVERT_HASH}" > "${OUTPUT_DIR}/.conversion-hash"
fi

xcrun swiftc -O -framework Foundation -framework CoreML -framework Accelerate \
  "${ROOT_DIR}/sidecars/granite/main.swift" -o "${OUTPUT_DIR}/memo-granite-asr"
chmod 755 "${OUTPUT_DIR}/memo-granite-asr"
cp "${MODEL_SOURCE}/tokenizer.json" "${OUTPUT_DIR}/tokenizer.json"

DEVICE_HASH="$(shasum -a 256 "${ROOT_DIR}/sidecars/granite/requirements-device.txt" | awk '{print $1}')"
if [[ ! -f "${DEVICE_RUNTIME}/.memo-runtime-version" ]] || [[ "$(cat "${DEVICE_RUNTIME}/.memo-runtime-version")" != "${DEVICE_HASH}" ]]; then
  rm -rf "${DEVICE_RUNTIME}" "${DEVICE_INSTALL}"
  UV_PYTHON_INSTALL_DIR="${DEVICE_INSTALL}" uv python install 3.12.11 --managed-python --no-progress
  PYTHON_BIN="$(find "${DEVICE_INSTALL}" -path '*/bin/python3.12' -type f | head -n 1)"
  uv pip install --python "${PYTHON_BIN}" --system --break-system-packages \
    --requirements "${ROOT_DIR}/sidecars/granite/requirements-device.txt" --no-progress
  mv "$(cd "$(dirname "${PYTHON_BIN}")/.." && pwd)" "${DEVICE_RUNTIME}"
  printf '%s\n' "${DEVICE_HASH}" > "${DEVICE_RUNTIME}/.memo-runtime-version"
fi

printf '%s\n' "model=${MODEL_REPO}" "revision=${MODEL_REVISION}" "model_sha256=${MODEL_SHA256}" "tokenizer_sha256=${TOKENIZER_SHA256}" "quantization=int4-per-block-32" "coremltools=9.0" > "${OUTPUT_DIR}/VERSIONS"
bash "${ROOT_DIR}/scripts/shell/verify-granite-bundle.sh" "${OUTPUT_DIR}"
du -sh "${OUTPUT_DIR}"
