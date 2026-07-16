#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${MEMO_STT_OUTPUT_DIR:-${ROOT_DIR}/.build/stt}"
OUTPUT_BIN="${OUTPUT_DIR}/memo-stt"
LOCAL_TARGET_DIR="${MEMO_STT_TARGET_DIR:-${ROOT_DIR}/.build/memo-stt-target}"
CRATE_NAME="${MEMO_STT_CRATE:-memo-stt}"
CRATE_VERSION="${MEMO_STT_VERSION:-0.1.1}"
FEATURES="${MEMO_STT_FEATURES:-binary}"
LOCAL_SOURCE="${MEMO_STT_LOCAL_SOURCE:-}"
SOURCE_ROOT="${ROOT_DIR}/.build/memo-stt-source"
PATCH_FILE="${ROOT_DIR}/patches/memo-stt-0.1.1-nemotron.patch"
CLEANUP_PATCH_FILE="${ROOT_DIR}/patches/memo-stt-0.1.1-cleanup.patch"
AUDIO_PATCH_FILE="${ROOT_DIR}/patches/memo-stt-0.1.1-audio-retention.patch"
TRANSCRIPTION_ENGINE="${ROOT_DIR}/sidecars/nemotron/transcription_engine.rs"

mkdir -p "${OUTPUT_DIR}"

if [[ -n "${LOCAL_SOURCE}" ]]; then
  if [[ ! -f "${LOCAL_SOURCE}/Cargo.toml" ]]; then
    echo "MEMO_STT_LOCAL_SOURCE must point to a directory containing Cargo.toml: ${LOCAL_SOURCE}" >&2
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
  if [[ "${CRATE_NAME}" != "memo-stt" || "${CRATE_VERSION}" != "0.1.1" ]]; then
    echo "The bundled Nemotron patch is pinned to memo-stt 0.1.1." >&2
    echo "Set MEMO_STT_LOCAL_SOURCE for a different source tree." >&2
    exit 1
  fi
  if [[ ! -f "${PATCH_FILE}" || ! -f "${CLEANUP_PATCH_FILE}" || ! -f "${AUDIO_PATCH_FILE}" || ! -f "${TRANSCRIPTION_ENGINE}" ]]; then
    echo "Nemotron memo-stt patch sources are missing." >&2
    exit 1
  fi

  PATCH_HASH="$(shasum -a 256 "${PATCH_FILE}" "${CLEANUP_PATCH_FILE}" "${AUDIO_PATCH_FILE}" "${TRANSCRIPTION_ENGINE}" | shasum -a 256 | awk '{print $1}')"
  SOURCE_DIR="${SOURCE_ROOT}/${CRATE_NAME}-${CRATE_VERSION}"
  PATCH_MARKER="${SOURCE_DIR}/.memo-nemotron-patch"
  CURRENT_HASH=""
  if [[ -f "${PATCH_MARKER}" ]]; then
    CURRENT_HASH="$(tr -d '[:space:]' < "${PATCH_MARKER}")"
  fi

  if [[ "${CURRENT_HASH}" != "${PATCH_HASH}" ]]; then
    rm -rf "${SOURCE_ROOT}"
    mkdir -p "${SOURCE_ROOT}"
    ARCHIVE="${SOURCE_ROOT}/${CRATE_NAME}-${CRATE_VERSION}.crate"
    echo "Downloading ${CRATE_NAME} ${CRATE_VERSION} source from crates.io"
    curl --fail --location --silent --show-error \
      "https://static.crates.io/crates/${CRATE_NAME}/${CRATE_NAME}-${CRATE_VERSION}.crate" \
      --output "${ARCHIVE}"
    tar -xzf "${ARCHIVE}" -C "${SOURCE_ROOT}"
    cp "${TRANSCRIPTION_ENGINE}" "${SOURCE_DIR}/src/transcription_engine.rs"
    patch -d "${SOURCE_DIR}" -p1 --forward --batch < "${PATCH_FILE}"
    patch -d "${SOURCE_DIR}" -p1 --forward --batch < "${CLEANUP_PATCH_FILE}"
    patch -d "${SOURCE_DIR}" -p1 --forward --batch < "${AUDIO_PATCH_FILE}"
    printf '%s\n' "${PATCH_HASH}" > "${PATCH_MARKER}"
  fi

  echo "Building patched ${CRATE_NAME} ${CRATE_VERSION} with the Nemotron backend"
  CARGO_TARGET_DIR="${LOCAL_TARGET_DIR}" cargo build \
    --release \
    --manifest-path "${SOURCE_DIR}/Cargo.toml" \
    --bin memo-stt \
    --features "${FEATURES}" \
    --locked

  SOURCE_BIN="${LOCAL_TARGET_DIR}/release/memo-stt"
  if [[ ! -f "${SOURCE_BIN}" ]]; then
    echo "Patched memo-stt build completed, but binary was not found at ${SOURCE_BIN}" >&2
    exit 1
  fi

  cp "${SOURCE_BIN}" "${OUTPUT_BIN}"
fi

chmod 755 "${OUTPUT_BIN}"
echo "memo-stt ready at ${OUTPUT_BIN}"
