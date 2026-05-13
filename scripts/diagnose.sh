#!/bin/bash

# Diagnostic script for Memo Desktop issues
# Run this on the account where Memo isn't working

echo "🔍 Memo Desktop Diagnostic Tool"
echo "================================"
echo ""

APP_PATH="/Applications/Memo.app"
BINARY_PATH="$APP_PATH/Contents/Resources/sttbin/memo-stt"

# Check 1: App exists
echo "1. Checking if Memo.app exists..."
if [ -d "$APP_PATH" ]; then
    echo "   ✅ Memo.app found at: $APP_PATH"
else
    echo "   ❌ Memo.app not found at: $APP_PATH"
    exit 1
fi

# Check 2: Binary exists
echo ""
echo "2. Checking if memo-stt binary exists..."
if [ -f "$BINARY_PATH" ]; then
    echo "   ✅ Binary found at: $BINARY_PATH"
    
    # Check binary size
    SIZE=$(stat -f%z "$BINARY_PATH" 2>/dev/null || stat -c%s "$BINARY_PATH" 2>/dev/null || echo "unknown")
    echo "   📦 Binary size: $SIZE bytes"
    
    # Check if executable
    if [ -x "$BINARY_PATH" ]; then
        echo "   ✅ Binary is executable"
    else
        echo "   ❌ Binary is NOT executable!"
        echo "   🔧 Attempting to fix..."
        chmod +x "$BINARY_PATH"
        if [ -x "$BINARY_PATH" ]; then
            echo "   ✅ Fixed! Binary is now executable"
        else
            echo "   ❌ Failed to make binary executable"
        fi
    fi
else
    echo "   ❌ Binary NOT found at: $BINARY_PATH"
    echo "   💡 This is a critical issue - the app was not built correctly"
    exit 1
fi

# Check 3: Code signing
echo ""
echo "3. Checking code signing..."
if codesign -dv "$BINARY_PATH" 2>&1 | grep -q "code object is not signed"; then
    echo "   ❌ Binary is NOT code signed!"
else
    echo "   ✅ Binary is code signed"
    codesign -dv "$BINARY_PATH" 2>&1 | grep -E "(Identifier|TeamIdentifier|Runtime)" | sed 's/^/      /'
fi

# Check 4: Try running binary
echo ""
echo "4. Testing if binary can run..."
if "$BINARY_PATH" --help 2>&1 | head -1 > /dev/null 2>&1; then
    echo "   ✅ Binary can execute"
    echo "   📝 Binary help output:"
    "$BINARY_PATH" --help 2>&1 | head -5 | sed 's/^/      /'
else
    EXIT_CODE=$?
    echo "   ❌ Binary failed to run (exit code: $EXIT_CODE)"
    echo "   📝 Error output:"
    "$BINARY_PATH" --help 2>&1 | sed 's/^/      /' || echo "      (no output)"
fi

# Check 5: Microphone permission
echo ""
echo "5. Checking microphone permission..."
if [ -f "/Library/Preferences/com.apple.security.plist" ]; then
    # Check TCC database (requires admin)
    echo "   ℹ️  Checking TCC database..."
    if tccutil reset Microphone com.memo.desktop 2>&1 | grep -q "reset"; then
        echo "   ⚠️  Microphone permission was reset (you'll need to grant it again)"
    fi
fi

# Check via system_profiler (if available)
if command -v system_profiler >/dev/null 2>&1; then
    echo "   ℹ️  Run this to check microphone permissions:"
    echo "      tccutil reset Microphone com.memo.desktop"
    echo "      (Then open Memo and grant permission when prompted)"
fi

# Check 6: User settings
echo ""
echo "6. Checking user settings..."
SETTINGS_FILE="$HOME/.memo-web-settings.json"
if [ -f "$SETTINGS_FILE" ]; then
    echo "   ✅ Settings file exists: $SETTINGS_FILE"
    echo "   📝 Contents:"
    cat "$SETTINGS_FILE" | sed 's/^/      /' || echo "      (could not read)"
else
    echo "   ⚠️  Settings file not found: $SETTINGS_FILE"
    echo "   💡 This is normal for a new user - will be created on first run"
fi

# Check 7: App settings
echo ""
echo "7. Checking app settings..."
APP_SETTINGS_DIR="$HOME/Library/Application Support/memo-desktop"
APP_SETTINGS_FILE="$APP_SETTINGS_DIR/settings.json"
if [ -f "$APP_SETTINGS_FILE" ]; then
    echo "   ✅ App settings file exists: $APP_SETTINGS_FILE"
    echo "   📝 Contents:"
    cat "$APP_SETTINGS_FILE" | sed 's/^/      /' || echo "      (could not read)"
else
    echo "   ⚠️  App settings file not found: $APP_SETTINGS_FILE"
    echo "   💡 This is normal for a new user - will be created on first run"
fi

# Check 8: Check Console logs
echo ""
echo "8. Recent Memo logs (last 20 lines)..."
echo "   💡 To see full logs, run: log show --predicate 'process == \"Memo\"' --last 5m"
if command -v log >/dev/null 2>&1; then
    log show --predicate 'process == "Memo" OR process == "memo-stt"' --last 2m --style compact 2>/dev/null | tail -20 | sed 's/^/      /' || echo "      (no recent logs found)"
else
    echo "   ⚠️  'log' command not available (requires macOS 10.12+)"
    echo "   💡 Check Console.app manually:"
    echo "      1. Open Console.app"
    echo "      2. Filter for 'Memo' or 'memo-stt'"
    echo "      3. Look for errors or warnings"
fi

# Check 9: Quarantine attributes
echo ""
echo "9. Checking quarantine attributes..."
if xattr -l "$APP_PATH" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo "   ⚠️  App has quarantine attribute (downloaded from internet)"
    echo "   🔧 Attempting to remove..."
    xattr -d com.apple.quarantine "$APP_PATH" 2>/dev/null && echo "   ✅ Quarantine removed" || echo "   ❌ Failed to remove quarantine"
else
    echo "   ✅ No quarantine attribute"
fi

# Check 10: Gatekeeper
echo ""
echo "10. Checking Gatekeeper status..."
if spctl --assess --verbose "$APP_PATH" 2>&1 | grep -q "accepted"; then
    echo "   ✅ App is accepted by Gatekeeper"
else
    echo "   ⚠️  App may not be accepted by Gatekeeper"
    spctl --assess --verbose "$APP_PATH" 2>&1 | sed 's/^/      /'
fi

echo ""
echo "================================"
echo "✅ Diagnostic complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Make sure microphone permission is granted:"
echo "      System Settings → Privacy & Security → Microphone → Enable 'Memo'"
echo ""
echo "   2. Try running Memo and check Console.app for errors:"
echo "      Console.app → Filter for 'Memo' or 'memo-stt'"
echo ""
echo "   3. If the function key still doesn't work, check if memo-stt is running:"
echo "      ps aux | grep memo-stt"
echo ""
echo "   4. Try manually running the binary to see errors:"
echo "      $BINARY_PATH --hotkey function"
echo ""
