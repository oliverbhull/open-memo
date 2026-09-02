#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_DIR="${1:-${ROOT_DIR}/.build/conomo}"

for required in conomo VERSIONS device-runtime/bin/python3.12; do
  [[ -e "${BUNDLE_DIR}/${required}" ]] || { echo "conomo bundle missing ${required}" >&2; exit 1; }
done
[[ -x "${BUNDLE_DIR}/conomo" ]] || { echo "conomo is not executable" >&2; exit 1; }
"${BUNDLE_DIR}/device-runtime/bin/python3.12" -B -c 'import serial; print(serial.VERSION)' >/dev/null
READY="$(printf '' | "${BUNDLE_DIR}/conomo" --worker | head -n 1)"
[[ "${READY}" == READY ]] || { echo "conomo did not become ready: ${READY}" >&2; exit 1; }
echo "conomo bundle verified at ${BUNDLE_DIR}"
