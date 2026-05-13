#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${HOME}/Builds/open-memo-dist}"

cd "${ROOT_DIR}"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

missing_env=()
for name in APPLE_TEAM_ID APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [[ -z "${!name:-}" ]]; then
    missing_env+=("${name}")
  fi
done

if (( ${#missing_env[@]} > 0 )); then
  echo "Missing Apple notarization environment variables: ${missing_env[*]}" >&2
  echo "See docs/maintainers/signing-and-release.md for local signing setup." >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "Developer ID Application certificate was not found in your local Keychain." >&2
  echo "Install/export your Apple Developer ID Application certificate before running a signed local validation build." >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"

export APPLE_TEAM_ID
export APPLE_API_KEY
export APPLE_API_KEY_ID
export APPLE_API_ISSUER
export CSC_IDENTITY_AUTO_DISCOVERY=true
export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-${HOME}/Builds/.electron-builder-cache}"
export npm_config_cache="${npm_config_cache:-${HOME}/Builds/.npm-cache}"

echo "Building signed and notarized Open Memo artifacts into ${OUTPUT_DIR}"
npm ci
npm run build:app
npx electron-builder \
  --mac \
  --publish=never \
  --config.mac.identity="Developer ID Application" \
  --config.directories.output="${OUTPUT_DIR}"

echo
echo "Local signed validation build complete:"
ls -lh "${OUTPUT_DIR}" || true
echo
echo "GitHub Releases are published by pushing a version tag, for example: git push origin v0.1.0"
