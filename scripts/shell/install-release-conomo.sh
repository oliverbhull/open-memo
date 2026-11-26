#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
archive="${1:?Pass the Conomo bundle archive}"
expected="${2:?Pass the expected SHA-256}"
output="${MEMO_CONOMO_OUTPUT_DIR:-${root}/.build/conomo}"
actual="$(shasum -a 256 "${archive}" | awk '{print $1}')"
if [[ "${actual}" != "${expected}" ]]; then
  echo 'Conomo release bundle checksum mismatch.' >&2
  exit 1
fi

mkdir -p "$(dirname "${output}")"
stage="$(mktemp -d "${output}.staging.XXXXXX")"
trap 'rm -rf "${stage}"' EXIT
uv run --no-project --python 3.12.11 python - "${archive}" "${stage}" <<'PY'
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    archive.extractall(sys.argv[2], filter="data")
PY
CONOMO_MODEL_DIR="${stage}/model" bash "${root}/scripts/shell/verify-conomo-bundle.sh" "${stage}"
rm -rf "${output}"
mv "${stage}" "${output}"
