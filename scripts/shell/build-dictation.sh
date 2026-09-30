#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CRATE_DIR="${ROOT_DIR}/sidecars/dictation"
TARGET_DIR="${ROOT_DIR}/.build/dictation-target"
OUTPUT_DIR="${ROOT_DIR}/.build/dictation"
OUTPUT="${OUTPUT_DIR}/memo-dictation"
CONTEXTUAL_OUTPUT="${OUTPUT_DIR}/memo-conomo-contextual"
CONTEXTUAL_LAUNCHER="${OUTPUT_DIR}/run-contextual-conomo"
CONTEXTUAL_BROKER="${OUTPUT_DIR}/contextual-worker.py"

mkdir -p "${OUTPUT_DIR}"
CARGO_TARGET_DIR="${TARGET_DIR}" cargo build \
  --manifest-path "${CRATE_DIR}/Cargo.toml" \
  --locked --release --bin memo-dictation
cp "${TARGET_DIR}/release/memo-dictation" "${OUTPUT}"
chmod 755 "${OUTPUT}"

xcrun swiftc -O -framework Foundation -framework CoreML -framework Accelerate \
  "${ROOT_DIR}/sidecars/conomo/contextual_worker.swift" \
  -o "${CONTEXTUAL_OUTPUT}"
chmod 755 "${CONTEXTUAL_OUTPUT}"
cp "${ROOT_DIR}/sidecars/conomo/run-contextual-conomo.sh" "${CONTEXTUAL_LAUNCHER}"
cp "${ROOT_DIR}/sidecars/conomo/contextual_worker.py" "${CONTEXTUAL_BROKER}"
chmod 755 "${CONTEXTUAL_LAUNCHER}"

if [[ "$(uname -s)" == "Darwin" && "${MEMO_SKIP_DICTATION_SIGNING:-0}" != "1" ]]; then
  SIGNING_IDENTITY="${MEMO_DICTATION_SIGN_IDENTITY:-Apple Development: Oliver Hull (858LS46YC8)}"
  if security find-identity -v -p codesigning | grep -Fq "${SIGNING_IDENTITY}"; then
    codesign --force --options runtime --identifier com.memo.desktop.dictation \
      --entitlements "${ROOT_DIR}/config/entitlements.dictation.plist" \
      --sign "${SIGNING_IDENTITY}" "${OUTPUT}"
    codesign --verify --strict --verbose "${OUTPUT}"
    codesign --force --options runtime --identifier com.memo.desktop.contextual-asr \
      --sign "${SIGNING_IDENTITY}" "${CONTEXTUAL_OUTPUT}"
    codesign --verify --strict --verbose "${CONTEXTUAL_OUTPUT}"
    echo "Signed Memo dictation sidecar as com.memo.desktop.dictation."
  else
    echo "Warning: signing identity not found; Memo dictation will require a new Input Monitoring grant." >&2
  fi
fi

echo "Owned Memo dictation sidecar is ready."
