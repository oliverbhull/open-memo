#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${MEMO_CLEANUP_OUTPUT_DIR:-${ROOT_DIR}/.build/cleanup}"
SOURCE="${CLEANUP_SOURCE:-}"
URL="${CLEANUP_URL:-}"
TOKEN="${CLEANUP_TOKEN:-}"
EXPECTED_SHA256="${CLEANUP_SHA256:-}"
MODEL_SOURCE="${MEMO_CLEANUP_MODEL:-${ROOT_DIR}/.build/transcript-cleanup-dataset/experiments/lfm2.5-1.2b-lora-v1/hybrid-v5/fused-step-1024-6bit}"
RUNTIME_SOURCE="${MEMO_CLEANUP_RUNTIME:-${ROOT_DIR}/.build/cleanup-runtime}"
LICENSE_URL="https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/raw/4393ab8222edb43a9290571b0575c696d73ab8e1/LICENSE"
LICENSE_SHA256="5188f2b355da20647257a3156db5834c794e5fb5e6d8dc4d4cdbb3180e75b85b"

mkdir -p "$(dirname "${OUTPUT_DIR}")"
if [[ -n "${SOURCE}" ]]; then
  [[ -d "${SOURCE}" ]] || { echo "CLEANUP_SOURCE must be a bundle directory: ${SOURCE}" >&2; exit 1; }
  rm -rf "${OUTPUT_DIR}"
  mkdir -p "${OUTPUT_DIR}"
  cp -R "${SOURCE}/." "${OUTPUT_DIR}/"
elif [[ -n "${URL}" ]]; then
  [[ "${URL}" == https://* ]] || { echo "CLEANUP_URL must use HTTPS" >&2; exit 1; }
  [[ -n "${EXPECTED_SHA256}" ]] || { echo "CLEANUP_SHA256 is required" >&2; exit 1; }
  ARCHIVE="${ROOT_DIR}/.build/cleanup-download.tar.gz"
  CURL_ARGS=(--fail --location --silent --show-error --header "Accept: application/octet-stream")
  [[ -z "${TOKEN}" ]] || CURL_ARGS+=(--header "Authorization: Bearer ${TOKEN}")
  curl "${CURL_ARGS[@]}" "${URL}" --output "${ARCHIVE}"
  ACTUAL_SHA256="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"
  [[ "${ACTUAL_SHA256}" == "${EXPECTED_SHA256}" ]] || { echo "cleanup archive checksum does not match CLEANUP_SHA256" >&2; exit 1; }
  rm -rf "${OUTPUT_DIR}"
  mkdir -p "${OUTPUT_DIR}"
  tar -xzf "${ARCHIVE}" -C "${OUTPUT_DIR}" --strip-components=1
elif [[ ! -f "${OUTPUT_DIR}/manifest.json" ]]; then
  [[ -d "${MODEL_SOURCE}" ]] || { echo "Cleanup model is missing: ${MODEL_SOURCE}" >&2; exit 1; }
  [[ -x "${RUNTIME_SOURCE}/bin/python" ]] || { echo "Cleanup runtime is missing: ${RUNTIME_SOURCE}" >&2; exit 1; }
  rm -rf "${OUTPUT_DIR}"
  mkdir -p "${OUTPUT_DIR}/model" "${OUTPUT_DIR}/worker"
  cp -R "${MODEL_SOURCE}/." "${OUTPUT_DIR}/model/"
  rm -f "${OUTPUT_DIR}/model/Desktop.ini"
  cp -R "${RUNTIME_SOURCE}" "${OUTPUT_DIR}/runtime"
  cp "${ROOT_DIR}/scripts/python/transcript-cleanup-worker.py" "${OUTPUT_DIR}/worker/"
  cp "${ROOT_DIR}/scripts/python/cleanup_prompt.py" "${OUTPUT_DIR}/worker/"
  cp "${ROOT_DIR}/scripts/python/cleanup_completion.py" "${OUTPUT_DIR}/worker/"
  curl --fail --location --silent --show-error "${LICENSE_URL}" --output "${OUTPUT_DIR}/LICENSE-LFM-1.0.txt"
  [[ "$(shasum -a 256 "${OUTPUT_DIR}/LICENSE-LFM-1.0.txt" | awk '{print $1}')" == "${LICENSE_SHA256}" ]] || { echo "LFM license checksum mismatch" >&2; exit 1; }
  cp "${RUNTIME_SOURCE}/lib/python3.12/LICENSE.txt" "${OUTPUT_DIR}/LICENSE-PYTHON.txt"
  printf '%s\n' 'Memo transcript cleanup uses Liquid AI LFM2.5-1.2B-Instruct, fine-tuned and quantized to affine group-64 6-bit MLX weights. See LICENSE-LFM-1.0.txt.' > "${OUTPUT_DIR}/NOTICE.txt"
  printf '%s\n' 'cleanup_model=memo-lfm-hybrid-v5-step-1024-6bit' 'precision=affine-group64-6bit' 'python=3.12' > "${OUTPUT_DIR}/VERSIONS"
  python3 "${ROOT_DIR}/scripts/python/write_cleanup_model_manifest.py" \
    --model "${OUTPUT_DIR}/model" \
    --candidate memo-lfm-hybrid-v5-step-1024-6bit \
    --precision affine-group64-6bit \
    --source-model LiquidAI/LFM2.5-1.2B-Instruct@4393ab8222edb43a9290571b0575c696d73ab8e1 \
    --prompt "${OUTPUT_DIR}/worker/cleanup_prompt.py" \
    --status production_ready
  python3 "${ROOT_DIR}/scripts/python/write_cleanup_bundle_manifest.py" "${OUTPUT_DIR}"
fi

bash "${ROOT_DIR}/scripts/shell/verify-cleanup-bundle.sh" "${OUTPUT_DIR}"
