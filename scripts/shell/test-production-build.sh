#!/usr/bin/env bash

# Test production build locally before deploying
# Usage: ./test-production-build.sh [unsigned|signed]
# Default: unsigned (faster)

set -e

BUILD_TYPE="${1:-unsigned}"

echo "Testing production build locally..."
echo ""

# Step 1: Build Rust release binary
echo "Building memo-stt release binary..."
npm run build:stt:release

# Step 2: Build React renderer
echo "Building React renderer..."
npm run build:renderer

# Step 3: Build app
if [ "$BUILD_TYPE" = "signed" ]; then
  echo "Building SIGNED app (requires code signing certificates)..."
  npm run dist:mac
  APP_PATH="dist/mac-arm64/Memo.app"
else
  echo "Building UNSIGNED app (faster, for quick testing)..."
  npm run build:dir
  APP_PATH="dist/mac-arm64/Memo.app"
fi

if [ ! -d "$APP_PATH" ]; then
  echo "Error: App not found at $APP_PATH"
  exit 1
fi

echo ""
echo "Build complete!"
echo ""

# Step 4: Remove old version
echo "Removing old version from Applications..."
rm -rf /Applications/Memo.app

# Step 5: Copy new version
echo "Copying new build to Applications..."
cp -R "$APP_PATH" /Applications/

# Step 6: Reset microphone permissions (to test fresh)
echo "Resetting microphone permissions (to test fresh)..."
tccutil reset Microphone com.memo.desktop 2>/dev/null || echo "Could not reset permissions (may not exist yet)"

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "1. Launch the app: open /Applications/Memo.app"
echo "2. Check System Settings → Privacy & Security → Microphone"
echo "3. Verify 'Memo' appears in the list"
echo "4. Grant microphone permission"
echo "5. Test microphone functionality"
echo ""
echo "To see console logs, run: /Applications/Memo.app/Contents/MacOS/Memo"

