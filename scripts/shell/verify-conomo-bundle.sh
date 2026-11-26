#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_DIR="${1:-${ROOT_DIR}/.build/conomo}"
MODEL_DIR="${CONOMO_MODEL_DIR:-${BUNDLE_DIR}/model}"
[[ -d "${MODEL_DIR}" ]] || { echo "Conomo model is missing" >&2; exit 1; }
ASSETS_ONLY="${2:-}"
for required in conomo LICENSE VERSIONS device-runtime/bin/python3.12; do
  [[ -f "${BUNDLE_DIR}/${required}" ]] || { echo "Conomo bundle missing ${required}" >&2; exit 1; }
done
[[ -x "${BUNDLE_DIR}/conomo" ]] || { echo 'Conomo worker is not executable' >&2; exit 1; }
DEVICE_PYTHON="${BUNDLE_DIR}/device-runtime/bin/python3.12"

if [[ -f "${BUNDLE_DIR}/runtime/model_assets.py" ]]; then
  for required in runtime/worker.py MODEL-LICENSE; do
    [[ -f "${BUNDLE_DIR}/${required}" ]] || { echo "Conomo bundle missing ${required}" >&2; exit 1; }
  done
  "${DEVICE_PYTHON}" -I -B "${BUNDLE_DIR}/runtime/model_assets.py" "${BUNDLE_DIR}/VERSIONS" "${MODEL_DIR}"
  if [[ "${ASSETS_ONLY}" != --assets-only ]]; then
    READY="$(CONOMO_MODEL_DIR="${MODEL_DIR}" "${BUNDLE_DIR}/conomo" --worker < /dev/null)"
    [[ "${READY}" == READY ]] || { echo "Conomo did not become ready: ${READY}" >&2; exit 1; }
  fi
  echo "Conomo bundle verified at ${BUNDLE_DIR}"
  exit 0
fi

for required in runtime/conomo/model-manifest.json THIRD_PARTY_NOTICES; do
  [[ -f "${BUNDLE_DIR}/${required}" ]] || { echo "Conomo bundle missing ${required}" >&2; exit 1; }
done
PYTHONPATH="${BUNDLE_DIR}/runtime" "${DEVICE_PYTHON}" -B -m conomo.models --verify "${MODEL_DIR}"
if [[ "${ASSETS_ONLY}" == --assets-only ]]; then exit 0; fi
"${DEVICE_PYTHON}" -B -c 'import numpy, onnxruntime, tokenizers'
# Isolate build validation from any installed runtime or active dictation.
CHECK_DIR="$(mktemp -d /tmp/conomo-check.XXXXXX)"
trap 'if [[ -f "${CHECK_DIR}/pid" ]]; then kill "$(cat "${CHECK_DIR}/pid")" 2>/dev/null || true; fi; rm -rf "${CHECK_DIR}"' EXIT
READY="$(printf '' | CONOMO_SOCKET="${CHECK_DIR}/speech.sock" "${BUNDLE_DIR}/conomo" --worker)"
[[ "${READY}" == READY ]] || { echo "Conomo did not become ready: ${READY}" >&2; exit 1; }
PYTHONPATH="${BUNDLE_DIR}/runtime" CONOMO_SOCKET="${CHECK_DIR}/speech.sock" "${BUNDLE_DIR}/device-runtime/bin/python3.12" -B -c 'from conomo.client import SpeechClient; import sys; c=SpeechClient(source="status"); open(sys.argv[1],"w").write(str(c.info["pid"])); c.close()' "${CHECK_DIR}/pid"
echo "Conomo bundle verified at ${BUNDLE_DIR}"
