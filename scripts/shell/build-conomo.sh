#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${MEMO_CONOMO_OUTPUT_DIR:-${ROOT_DIR}/.build/conomo}"
DEVICE_INSTALL="${ROOT_DIR}/.build/conomo-device-python-install"
DEVICE_RUNTIME="${OUTPUT_DIR}/device-runtime"
mkdir -p "${OUTPUT_DIR}"
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


rm -rf "${OUTPUT_DIR}/runtime"
mkdir -p "${OUTPUT_DIR}/runtime"
cp -R "${ROOT_DIR}/runtimes/conomo/conomo" "${OUTPUT_DIR}/runtime/conomo"
find "${OUTPUT_DIR}/runtime" -type d -name __pycache__ -exec rm -rf {} +
cp "${ROOT_DIR}/runtimes/conomo/LICENSE" "${ROOT_DIR}/runtimes/conomo/THIRD_PARTY_NOTICES" "${OUTPUT_DIR}/"
cp "${ROOT_DIR}/runtimes/conomo/run-worker" "${OUTPUT_DIR}/conomo"
chmod 755 "${OUTPUT_DIR}/conomo"
MODEL_ARGS=(--destination "${OUTPUT_DIR}/model")
[[ -z "${CONOMO_MODEL_SOURCE:-}" ]] || MODEL_ARGS+=(--source "${CONOMO_MODEL_SOURCE}")
[[ "${CONOMO_OFFLINE:-0}" != 1 ]] || MODEL_ARGS+=(--offline)
PYTHONPATH="${OUTPUT_DIR}/runtime" "${DEVICE_RUNTIME}/bin/python3.12" -B -m conomo.models "${MODEL_ARGS[@]}"
cp "${ROOT_DIR}/runtimes/conomo/conomo/model-manifest.json" "${OUTPUT_DIR}/VERSIONS"
bash "${ROOT_DIR}/scripts/shell/verify-conomo-bundle.sh" "${OUTPUT_DIR}"
