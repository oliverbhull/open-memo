#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_DIR="${1:-${ROOT_DIR}/.build/conomo}"
for required in conomo model runtime/conomo/model-manifest.json LICENSE THIRD_PARTY_NOTICES VERSIONS device-runtime/bin/python3.12; do
  [[ -e "${BUNDLE_DIR}/${required}" ]] || { echo "Conomo bundle missing ${required}" >&2; exit 1; }
done
[[ -x "${BUNDLE_DIR}/conomo" ]] || { echo 'Conomo bridge is not executable' >&2; exit 1; }
PYTHONPATH="${BUNDLE_DIR}/runtime" "${BUNDLE_DIR}/device-runtime/bin/python3.12" -B -m conomo.models --verify "${BUNDLE_DIR}/model"
"${BUNDLE_DIR}/device-runtime/bin/python3.12" -B -c 'import serial, numpy, onnxruntime, tokenizers'
# Isolate build validation from any installed runtime or active dictation.
CHECK_DIR="$(mktemp -d /tmp/conomo-check.XXXXXX)"
trap 'if [[ -f "${CHECK_DIR}/pid" ]]; then kill "$(cat "${CHECK_DIR}/pid")" 2>/dev/null || true; fi; rm -rf "${CHECK_DIR}"' EXIT
READY="$(printf '' | CONOMO_SOCKET="${CHECK_DIR}/speech.sock" "${BUNDLE_DIR}/conomo" --worker)"
[[ "${READY}" == READY ]] || { echo "Conomo did not become ready: ${READY}" >&2; exit 1; }
PYTHONPATH="${BUNDLE_DIR}/runtime" CONOMO_SOCKET="${CHECK_DIR}/speech.sock" "${BUNDLE_DIR}/device-runtime/bin/python3.12" -B -c 'from conomo.client import SpeechClient; import sys; c=SpeechClient(source="status"); open(sys.argv[1],"w").write(str(c.info["pid"])); c.close()' "${CHECK_DIR}/pid"
echo "Conomo bundle verified at ${BUNDLE_DIR}"
