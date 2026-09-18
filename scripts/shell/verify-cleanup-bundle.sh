#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_DIR="${1:-${ROOT_DIR}/.build/cleanup}"

for required in manifest.json model-pack.json model/memo-cleanup-model.json model/model.safetensors model/config.json model/tokenizer.json runtime/bin/python worker/transcript-cleanup-worker.py worker/cleanup_prompt.py worker/cleanup_completion.py LICENSE-LFM-1.0.txt NOTICE.txt VERSIONS; do
  [[ -e "${BUNDLE_DIR}/${required}" ]] || { echo "cleanup bundle missing ${required}" >&2; exit 1; }
done
[[ -x "${BUNDLE_DIR}/runtime/bin/python" ]] || { echo "cleanup Python is not executable" >&2; exit 1; }

python3 - "${BUNDLE_DIR}" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
bundle = json.loads((root / "manifest.json").read_text())
model = json.loads((root / "model/memo-cleanup-model.json").read_text())
assert bundle.get("schema_version") == 1
assert bundle.get("precision") == "affine-group64-6bit"
assert bundle.get("candidate") == "memo-lfm-hybrid-v5-step-1024-6bit"
if not bundle.get("fixture"):
    assert bundle.get("status") == "production_ready"
    assert model.get("status") == "production_ready"
assert model.get("precision") == "affine-group64-6bit"
prompt_hash = hashlib.sha256((root / "worker/cleanup_prompt.py").read_bytes()).hexdigest()
assert model.get("prompt_sha256") == prompt_hash
for relative, expected in bundle.get("files", {}).items():
    target = root / relative
    assert target.is_file(), relative
    assert target.stat().st_size == expected["bytes"], relative
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    assert digest == expected["sha256"], relative
PY

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 \
  "${BUNDLE_DIR}/runtime/bin/python" -B "${BUNDLE_DIR}/worker/transcript-cleanup-worker.py" --self-test >/dev/null
echo "cleanup bundle verified at ${BUNDLE_DIR}"
