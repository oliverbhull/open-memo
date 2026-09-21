#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

VERSION="$(node -p "require('./package.json').version")"
FULL_UPDATE="$(node -e "const versions=require('./config/full-model-update-versions.json'); process.stdout.write(versions.includes(process.argv[1]) ? '1' : '0')" "${VERSION}")"

if [[ "${FULL_UPDATE}" == "1" ]]; then
  echo "Building required full-model transition update for ${VERSION}"
  # Both artifacts contain the same complete app, so sign and notarize it once.
  npx electron-builder --mac dmg zip --publish=never
else
  # Every release needs a current, self-contained clean installer. The updater
  # remains thin so existing installations keep their persistent model packs.
  # Use a separate output tree so the second signing pass never reuses the
  # notarized full app's staging path.
  npx electron-builder --mac dmg --publish=never
  echo "Building lightweight app-only update for ${VERSION}"
  MEMO_THIN_UPDATE=1 npx electron-builder --mac zip --publish=never \
    --config.directories.output=dist-thin
  cp "dist-thin/Open-Memo-${VERSION}-arm64.zip" dist/
  cp dist-thin/latest-mac.yml dist/
  rm -rf dist/mac-arm64
  cp -R dist-thin/mac-arm64 dist/mac-arm64
fi
