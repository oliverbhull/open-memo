#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${1:-${ROOT_DIR}/.build/cleanup-fixture}"
rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}/model" "${OUTPUT_DIR}/runtime/bin" "${OUTPUT_DIR}/worker"
printf 'fixture\n' > "${OUTPUT_DIR}/model/model.safetensors"
printf '{}\n' > "${OUTPUT_DIR}/model/config.json"
printf '{}\n' > "${OUTPUT_DIR}/model/tokenizer.json"
cp "${ROOT_DIR}/scripts/python/transcript-cleanup-worker.py" "${OUTPUT_DIR}/worker/"
cp "${ROOT_DIR}/scripts/python/cleanup_prompt.py" "${OUTPUT_DIR}/worker/"
cp "${ROOT_DIR}/scripts/python/cleanup_completion.py" "${OUTPUT_DIR}/worker/"
printf '%s\n' '#!/usr/bin/env bash' 'exec /usr/bin/python3 "$@"' > "${OUTPUT_DIR}/runtime/bin/python"
chmod 755 "${OUTPUT_DIR}/runtime/bin/python"
printf '%s\n' 'CI protocol fixture; not licensed or usable as a model.' > "${OUTPUT_DIR}/LICENSE-LFM-1.0.txt"
printf '%s\n' 'Protocol-only CI fixture. Signed builds reject this bundle.' > "${OUTPUT_DIR}/NOTICE.txt"
printf '%s\n' 'cleanup_model=fixture' 'precision=affine-group64-6bit' > "${OUTPUT_DIR}/VERSIONS"
python3 "${ROOT_DIR}/scripts/python/write_cleanup_model_manifest.py" \
  --model "${OUTPUT_DIR}/model" --candidate memo-lfm-hybrid-v5-step-1024-6bit \
  --precision affine-group64-6bit --source-model fixture \
  --prompt "${OUTPUT_DIR}/worker/cleanup_prompt.py" --status fixture
python3 "${ROOT_DIR}/scripts/python/write_cleanup_bundle_manifest.py" "${OUTPUT_DIR}" --fixture
bash "${ROOT_DIR}/scripts/shell/verify-cleanup-bundle.sh" "${OUTPUT_DIR}"
