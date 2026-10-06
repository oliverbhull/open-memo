#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

VERSION="$(node -p "require('./package.json').version")"
echo "Building self-contained Memo installer and update for ${VERSION}"
# Existing installations must receive the included speech model as well as the
# app code. Sign and notarize the same complete app once for both artifacts.
npx electron-builder --mac dmg zip --publish=never
