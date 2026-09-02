#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_DIR="${1:-${ROOT_DIR}/.build/pnc}"
MODEL_DIR="$(find "${BUNDLE_DIR}/compiled" -maxdepth 1 -type d -name '*.mlmodelc' | head -n 1)"
for required in memo-pnc tokenizer.vocab manifest.json VERSIONS NOTICE.md; do
  [[ -e "${BUNDLE_DIR}/${required}" ]] || { echo "PnC bundle missing ${required}" >&2; exit 1; }
done
[[ -n "${MODEL_DIR}" ]] || { echo "PnC bundle missing compiled .mlmodelc" >&2; exit 1; }
[[ "$(jq -r .quantization "${BUNDLE_DIR}/manifest.json")" == int8-linear-symmetric ]] || { echo "PnC manifest is not INT8" >&2; exit 1; }
[[ -x "${BUNDLE_DIR}/memo-pnc" ]] || { echo "PnC worker is not executable" >&2; exit 1; }
OUTPUT="$(printf '%s\n' '{"id":"verify","text":"how are you"}' | "${BUNDLE_DIR}/memo-pnc" --model-path "${MODEL_DIR}" --vocabulary-path "${BUNDLE_DIR}/tokenizer.vocab" --worker)"
[[ "$(printf '%s\n' "${OUTPUT}" | head -n 1)" == READY ]] || { echo "PnC worker did not become ready" >&2; exit 1; }
[[ "$(printf '%s\n' "${OUTPUT}" | tail -n 1 | jq -r .text)" == "How are you?" ]] || { echo "PnC worker returned unexpected text" >&2; exit 1; }
echo "DistilBERT punctuation and capitalization bundle verified at ${BUNDLE_DIR}"
