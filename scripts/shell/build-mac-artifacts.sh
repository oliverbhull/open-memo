#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

VERSION="$(node -p "require('./package.json').version")"
FULL_UPDATE="$(node -e "const versions=require('./config/full-model-update-versions.json'); process.stdout.write(versions.includes(process.argv[1]) ? '1' : '0')" "${VERSION}")"

# The DMG is always a complete clean installer.
npx electron-builder --mac dmg --publish=never

if [[ "${FULL_UPDATE}" == "1" ]]; then
  echo "Building required full-model transition update for ${VERSION}"
  npx electron-builder --mac zip --publish=never
else
  echo "Building lightweight app-only update for ${VERSION}"
  MEMO_THIN_UPDATE=1 npx electron-builder --mac zip --publish=never
fi
