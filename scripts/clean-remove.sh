#!/bin/bash

# Complete removal script for Memo Desktop
# This will delete the app and ALL associated data

echo "🗑️  Memo Desktop Complete Removal"
echo "=================================="
echo ""
echo "⚠️  WARNING: This will permanently delete:"
echo "   - Memo.app from /Applications"
echo "   - All your memos and transcriptions"
echo "   - All app settings"
echo "   - All user preferences"
echo ""
read -p "Are you sure you want to continue? (yes/no): " confirm

if [[ "$confirm" != "yes" ]]; then
    echo "❌ Removal cancelled."
    exit 0
fi

echo ""
echo "Removing Memo Desktop..."

# 1. Remove the app
if [ -d "/Applications/Memo.app" ]; then
    echo "   📦 Removing Memo.app..."
    rm -rf "/Applications/Memo.app"
    echo "   ✅ Memo.app removed"
else
    echo "   ℹ️  Memo.app not found in /Applications"
fi

# 2. Remove app data directory
APP_DATA_DIR="$HOME/Library/Application Support/memo-desktop"
if [ -d "$APP_DATA_DIR" ]; then
    echo "   📁 Removing app data directory..."
    rm -rf "$APP_DATA_DIR"
    echo "   ✅ App data removed (includes all memos and IndexedDB)"
else
    echo "   ℹ️  App data directory not found"
fi

# 3. Remove user settings file
USER_SETTINGS="$HOME/.memo-web-settings.json"
if [ -f "$USER_SETTINGS" ]; then
    echo "   ⚙️  Removing user settings..."
    rm -f "$USER_SETTINGS"
    echo "   ✅ User settings removed"
else
    echo "   ℹ️  User settings file not found"
fi

# 4. Remove any cached data
CACHE_DIR="$HOME/Library/Caches/memo-desktop"
if [ -d "$CACHE_DIR" ]; then
    echo "   🗂️  Removing cache..."
    rm -rf "$CACHE_DIR"
    echo "   ✅ Cache removed"
fi

# 5. Remove logs (optional)
LOG_DIR="$HOME/Library/Logs/memo-desktop"
if [ -d "$LOG_DIR" ]; then
    echo "   📝 Removing logs..."
    rm -rf "$LOG_DIR"
    echo "   ✅ Logs removed"
fi

# 6. Reset permissions (optional - removes from System Settings)
echo ""
echo "   🔐 Note: You may want to manually remove Memo from:"
echo "      - System Settings → Privacy & Security → Microphone"
echo "      - System Settings → Privacy & Security → Input Monitoring"
echo "      - System Settings → Privacy & Security → Accessibility"
echo ""
echo "   Or run: tccutil reset Microphone com.memo.desktop"
echo "   Or run: tccutil reset ListenEvent com.memo.desktop"
echo "   Or run: tccutil reset Accessibility com.memo.desktop"

echo ""
echo "✅ Memo Desktop completely removed!"
echo ""
echo "You can now download and install a fresh copy."
