#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${MEMO_STT_OUTPUT_DIR:-${ROOT_DIR}/.build/stt}"
OUTPUT_BIN="${OUTPUT_DIR}/memo-stt"
LOCAL_TARGET_DIR="${MEMO_STT_TARGET_DIR:-${ROOT_DIR}/.build/memo-stt-target}"
INSTALL_TARGET_DIR="${MEMO_STT_INSTALL_TARGET_DIR:-${ROOT_DIR}/.build/cargo-target}"
CRATE_NAME="${MEMO_STT_CRATE:-memo-stt}"
CRATE_VERSION="${MEMO_STT_VERSION:-0.1.1}"
FEATURES="${MEMO_STT_FEATURES:-binary}"
LOCAL_SOURCE="${MEMO_STT_PATH:-}"

mkdir -p "${OUTPUT_DIR}"

if [[ -n "${LOCAL_SOURCE}" ]]; then
  if [[ ! -f "${LOCAL_SOURCE}/Cargo.toml" ]]; then
    echo "MEMO_STT_PATH must point to a directory containing Cargo.toml: ${LOCAL_SOURCE}" >&2
    exit 1
  fi

  echo "Building memo-stt from local source: ${LOCAL_SOURCE}"
  CARGO_TARGET_DIR="${LOCAL_TARGET_DIR}" cargo build \
    --release \
    --manifest-path "${LOCAL_SOURCE}/Cargo.toml" \
    --bin memo-stt \
    --features "${FEATURES}"

  SOURCE_BIN="${LOCAL_TARGET_DIR}/release/memo-stt"
  if [[ ! -f "${SOURCE_BIN}" ]]; then
    echo "Local memo-stt build completed, but binary was not found at ${SOURCE_BIN}" >&2
    exit 1
  fi

  cp "${SOURCE_BIN}" "${OUTPUT_BIN}"
else
  INSTALL_ROOT="${ROOT_DIR}/.build/cargo-install"
  INSTALL_BIN="${INSTALL_ROOT}/bin/memo-stt"

  echo "Installing ${CRATE_NAME} ${CRATE_VERSION} from crates.io"
  CARGO_TARGET_DIR="${INSTALL_TARGET_DIR}" cargo install "${CRATE_NAME}" \
    --version "${CRATE_VERSION}" \
    --features "${FEATURES}" \
    --locked \
    --root "${INSTALL_ROOT}" \
    --force

  if [[ ! -f "${INSTALL_BIN}" ]]; then
    echo "cargo install completed, but memo-stt was not found at ${INSTALL_BIN}" >&2
    exit 1
  fi

  cp "${INSTALL_BIN}" "${OUTPUT_BIN}"
fi

chmod 755 "${OUTPUT_BIN}"
echo "memo-stt ready at ${OUTPUT_BIN}"
