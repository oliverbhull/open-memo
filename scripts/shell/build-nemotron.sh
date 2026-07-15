#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${MEMO_NEMOTRON_OUTPUT_DIR:-${ROOT_DIR}/.build/nemotron}"
RUNTIME_DIR="${OUTPUT_DIR}/runtime"
MODEL_DIR="${OUTPUT_DIR}/model"
WORKER_SOURCE="${ROOT_DIR}/sidecars/nemotron/memo_nemotron.py"
REQUIREMENTS="${ROOT_DIR}/sidecars/nemotron/requirements.txt"
PYTHON_VERSION="3.12.11"
MODEL_REPO="onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4"
MODEL_REVISION="8364d9e2dd9da23789b480bdbba9e423717e42ee"
MODEL_SOURCE="${MEMO_NEMOTRON_MODEL_SOURCE:-}"
UV_CACHE_DIR="${UV_CACHE_DIR:-${ROOT_DIR}/.build/uv-cache}"
MODEL_FILES=(
  genai_config.json
  model_config.json
  audio_processor_config.json
  tokenizer.json
  tokenizer_config.json
  vocab.txt
  encoder.onnx
  encoder.onnx.data
  decoder.onnx
  decoder.onnx.data
  joint.onnx
  joint.onnx.data
)
MODEL_MARKER="${MODEL_DIR}/.memo-model-revision"
EXPECTED_MODEL_ID="${MODEL_REPO}@${MODEL_REVISION}"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to build the bundled Nemotron runtime." >&2
  echo "Install it from https://docs.astral.sh/uv/ or run CI with astral-sh/setup-uv." >&2
  exit 1
fi
if [[ ! -f "${WORKER_SOURCE}" || ! -f "${REQUIREMENTS}" ]]; then
  echo "Nemotron worker sources are missing." >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}" "${UV_CACHE_DIR}"
install -m 644 "${WORKER_SOURCE}" "${OUTPUT_DIR}/memo_nemotron.py"

RUNTIME_HASH="$(printf '%s\n' "${PYTHON_VERSION}" "$(shasum -a 256 "${REQUIREMENTS}" | awk '{print $1}')" | shasum -a 256 | awk '{print $1}')"
RUNTIME_MARKER="${RUNTIME_DIR}/.memo-runtime-version"
CURRENT_RUNTIME_HASH=""
if [[ -f "${RUNTIME_MARKER}" ]]; then
  CURRENT_RUNTIME_HASH="$(tr -d '[:space:]' < "${RUNTIME_MARKER}")"
fi

if [[ "${CURRENT_RUNTIME_HASH}" != "${RUNTIME_HASH}" ]]; then
  PYTHON_INSTALL_ROOT="${ROOT_DIR}/.build/nemotron-python-install"
  rm -rf "${RUNTIME_DIR}" "${PYTHON_INSTALL_ROOT}"
  mkdir -p "${PYTHON_INSTALL_ROOT}"

  echo "Installing relocatable CPython ${PYTHON_VERSION}"
  UV_CACHE_DIR="${UV_CACHE_DIR}" UV_PYTHON_INSTALL_DIR="${PYTHON_INSTALL_ROOT}" \
    uv python install "${PYTHON_VERSION}" --managed-python --no-progress

  PYTHON_BIN="$(find "${PYTHON_INSTALL_ROOT}" -path '*/bin/python3.12' -type f | head -n 1)"
  if [[ -z "${PYTHON_BIN}" ]]; then
    echo "uv installed Python, but bin/python3.12 was not found." >&2
    exit 1
  fi
  PYTHON_PREFIX="$(cd "$(dirname "${PYTHON_BIN}")/.." && pwd)"

  echo "Installing pinned Nemotron Python dependencies"
  UV_CACHE_DIR="${UV_CACHE_DIR}" uv pip install \
    --python "${PYTHON_BIN}" \
    --system \
    --break-system-packages \
    --requirements "${REQUIREMENTS}" \
    --no-progress

  mv "${PYTHON_PREFIX}" "${RUNTIME_DIR}"
  printf '%s\n' "${RUNTIME_HASH}" > "${RUNTIME_MARKER}"
fi

"${RUNTIME_DIR}/bin/python3.12" -c 'import numpy, onnxruntime_genai'

MODEL_COMPLETE=true
if [[ ! -f "${MODEL_MARKER}" ]] || [[ "$(tr -d '[:space:]' < "${MODEL_MARKER}")" != "${EXPECTED_MODEL_ID}" ]]; then
  MODEL_COMPLETE=false
fi
for required in "${MODEL_FILES[@]}"; do
  if [[ ! -f "${MODEL_DIR}/${required}" ]]; then
    MODEL_COMPLETE=false
    break
  fi
done

if [[ -n "${MODEL_SOURCE}" ]]; then
  if [[ ! -f "${MODEL_SOURCE}/genai_config.json" ]]; then
    echo "MEMO_NEMOTRON_MODEL_SOURCE is not a Nemotron ONNX model directory: ${MODEL_SOURCE}" >&2
    exit 1
  fi
  echo "Staging Nemotron model from ${MODEL_SOURCE}"
  mkdir -p "${MODEL_DIR}"
  rsync -a --delete --exclude '.cache' "${MODEL_SOURCE}/" "${MODEL_DIR}/"
elif [[ "${MODEL_COMPLETE}" != true ]]; then
  echo "Downloading ${MODEL_REPO} at ${MODEL_REVISION}"
  rm -rf "${MODEL_DIR}"
  UV_CACHE_DIR="${UV_CACHE_DIR}" uvx --from huggingface-hub==1.21.0 \
    hf download "${MODEL_REPO}" \
    --revision "${MODEL_REVISION}" \
    --local-dir "${MODEL_DIR}"
  rm -rf "${MODEL_DIR}/.cache"
fi

printf '%s\n' "${EXPECTED_MODEL_ID}" > "${MODEL_MARKER}"

for required in "${MODEL_FILES[@]}"; do
  if [[ ! -f "${MODEL_DIR}/${required}" ]]; then
    echo "Nemotron model is incomplete: missing ${MODEL_DIR}/${required}" >&2
    exit 1
  fi
done

printf '%s\n' \
  "python=${PYTHON_VERSION}" \
  "onnxruntime-genai=0.14.1" \
  "model=${MODEL_REPO}" \
  "revision=${MODEL_REVISION}" \
  > "${OUTPUT_DIR}/VERSIONS"

echo "Nemotron bundle ready at ${OUTPUT_DIR}"
du -sh "${OUTPUT_DIR}"
