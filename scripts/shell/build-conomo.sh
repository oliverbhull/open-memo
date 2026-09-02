#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${MEMO_CONOMO_OUTPUT_DIR:-${ROOT_DIR}/.build/conomo}"
SOURCE="${CONOMO_SOURCE:-}"
URL="${CONOMO_URL:-}"
TOKEN="${CONOMO_TOKEN:-}"
EXPECTED_SHA256="${CONOMO_SHA256:-}"
DEVICE_INSTALL="${ROOT_DIR}/.build/conomo-device-python-install"
DEVICE_RUNTIME="${OUTPUT_DIR}/device-runtime"

mkdir -p "${OUTPUT_DIR}"

if [[ -n "${SOURCE}" ]]; then
  [[ -f "${SOURCE}" ]] || { echo "CONOMO_SOURCE is not a file: ${SOURCE}" >&2; exit 1; }
  cp "${SOURCE}" "${OUTPUT_DIR}/conomo"
elif [[ -n "${URL}" ]]; then
  [[ "${URL}" == https://* ]] || { echo "CONOMO_URL must use HTTPS" >&2; exit 1; }
  ARCHIVE="${ROOT_DIR}/.build/conomo-download.tar.gz"
  CURL_ARGS=(--fail --location --silent --show-error --header "Accept: application/octet-stream")
  [[ -z "${TOKEN}" ]] || CURL_ARGS+=(--header "Authorization: Bearer ${TOKEN}")
  curl "${CURL_ARGS[@]}" "${URL}" --output "${ARCHIVE}"
  ACTUAL_SHA256="$(shasum -a 256 "${ARCHIVE}" | awk '{print $1}')"
  [[ -n "${EXPECTED_SHA256}" ]] || { echo "CONOMO_SHA256 is required" >&2; exit 1; }
  [[ "${ACTUAL_SHA256}" == "${EXPECTED_SHA256}" ]] || { echo "conomo archive checksum does not match CONOMO_SHA256" >&2; exit 1; }
  rm -rf "${OUTPUT_DIR}"
  mkdir -p "${OUTPUT_DIR}"
  tar -xzf "${ARCHIVE}" -C "${OUTPUT_DIR}" --strip-components=1
elif [[ ! -f "${OUTPUT_DIR}/conomo" ]]; then
  echo "Provide the compiled conomo executable with CONOMO_SOURCE or CONOMO_URL." >&2
  exit 1
fi

[[ -n "${EXPECTED_SHA256}" ]] || { echo "CONOMO_SHA256 is required" >&2; exit 1; }
if [[ -z "${URL}" ]]; then
  ACTUAL_SHA256="$(shasum -a 256 "${OUTPUT_DIR}/conomo" | awk '{print $1}')"
  [[ "${ACTUAL_SHA256}" == "${EXPECTED_SHA256}" ]] || { echo "conomo checksum does not match CONOMO_SHA256" >&2; exit 1; }
fi
chmod 755 "${OUTPUT_DIR}/conomo"

command -v uv >/dev/null || { echo "uv is required to build the device runtime" >&2; exit 1; }
DEVICE_REQUIREMENTS="${ROOT_DIR}/sidecars/conomo/requirements-device.txt"
DEVICE_HASH="$(shasum -a 256 "${DEVICE_REQUIREMENTS}" | awk '{print $1}')"
if [[ ! -f "${DEVICE_RUNTIME}/.memo-runtime-version" ]] || [[ "$(cat "${DEVICE_RUNTIME}/.memo-runtime-version")" != "${DEVICE_HASH}" ]]; then
  rm -rf "${DEVICE_RUNTIME}" "${DEVICE_INSTALL}"
  UV_PYTHON_INSTALL_DIR="${DEVICE_INSTALL}" uv python install 3.12.11 --managed-python --no-progress
  PYTHON_BIN="$(find "${DEVICE_INSTALL}" -path '*/bin/python3.12' -type f | head -n 1)"
  uv pip install --python "${PYTHON_BIN}" --system --break-system-packages \
    --requirements "${DEVICE_REQUIREMENTS}" --no-progress
  mv "$(cd "$(dirname "${PYTHON_BIN}")/.." && pwd)" "${DEVICE_RUNTIME}"
  printf '%s\n' "${DEVICE_HASH}" > "${DEVICE_RUNTIME}/.memo-runtime-version"
fi

printf '%s\n' "artifact_sha256=${ACTUAL_SHA256}" > "${OUTPUT_DIR}/VERSIONS"
bash "${ROOT_DIR}/scripts/shell/verify-conomo-bundle.sh" "${OUTPUT_DIR}"
