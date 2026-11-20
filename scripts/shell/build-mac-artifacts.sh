#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

VERSION="$(node -p "require('./package.json').version")"
echo "Building self-contained Memo installer and lightweight update for ${VERSION}"
# Keep first installation offline-ready. Update ZIPs carry code and runtimes;
# immutable model assets are published separately and reused across app releases.
# Older clients keep using the self-contained channel for a safe transition.
npx electron-builder --mac dmg zip --publish=never
cp dist/latest-mac.yml dist/full-latest-mac.yml
MEMO_SLIM_UPDATE=1 npx electron-builder --mac zip --publish=never --config.artifactName='Open-Memo-${version}-app-${arch}.${ext}'
cp dist/latest-mac.yml dist/app-mac.yml
mv dist/full-latest-mac.yml dist/latest-mac.yml
