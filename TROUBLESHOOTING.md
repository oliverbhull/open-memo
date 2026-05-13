# Memo Desktop Troubleshooting Guide

## Issue: Function Key Not Working on Fresh Account

If Memo installs but the function key doesn't trigger recording on a new user account, follow these steps:

### Quick Diagnostic

Run the diagnostic script on the affected account:

```bash
cd /path/to/memo-desktop
./scripts/diagnose.sh
```

This will check:
- ✅ Binary exists and is executable
- ✅ Code signing status
- ✅ Permissions
- ✅ Settings files
- ✅ Recent logs

### Common Issues & Solutions

#### 1. Microphone Permission Not Granted

**Symptoms:**
- App opens but function key does nothing
- No recording indicator appears
- No error messages shown

**Solution:**
1. Open **System Settings** → **Privacy & Security** → **Microphone**
2. Find **Memo** in the list
3. Enable the toggle next to it
4. If Memo is not in the list:
   - Open Memo app
   - It should prompt for microphone access
   - Click "Allow" when prompted
   - If no prompt appears, try:
     ```bash
     tccutil reset Microphone com.memo.desktop
     ```
   - Then reopen Memo

#### 2. Binary Not Executable

**Symptoms:**
- Error in logs: "EACCES" or "permission denied"
- Binary exists but can't run

**Solution:**
```bash
chmod +x /Applications/Memo.app/Contents/Resources/sttbin/memo-stt
```

#### 3. Quarantine Attribute (Downloaded from Internet)

**Symptoms:**
- App won't run or shows security warning
- Binary is blocked by macOS

**Solution:**
```bash
xattr -d com.apple.quarantine /Applications/Memo.app
```

#### 4. memo-stt Process Not Running

**Check if process is running:**
```bash
ps aux | grep memo-stt
```

**If not running, check logs:**
1. Open **Console.app**
2. Filter for "Memo" or "memo-stt"
3. Look for errors like:
   - "Failed to start memo-stt"
   - "binary not found"
   - "permission denied"

**Try running binary manually:**
```bash
/Applications/Memo.app/Contents/Resources/sttbin/memo-stt --hotkey function
```

This will show any errors directly.

#### 5. Settings Files Missing

**Check user settings:**
```bash
cat ~/.memo-web-settings.json
```

**Check app settings:**
```bash
cat ~/Library/Application\ Support/memo-desktop/settings.json
```

If these don't exist, they'll be created on first run. This is normal.

### Debugging Steps

1. **Check Console Logs:**
   ```bash
   log show --predicate 'process == "Memo" OR process == "memo-stt"' --last 5m --style compact
   ```

2. **Check if binary can run:**
   ```bash
   /Applications/Memo.app/Contents/Resources/sttbin/memo-stt --help
   ```

3. **Verify code signing:**
   ```bash
   codesign -dv /Applications/Memo.app/Contents/Resources/sttbin/memo-stt
   ```

4. **Check microphone permission:**
   ```bash
   tccutil reset Microphone com.memo.desktop
   # Then reopen Memo and grant permission
   ```

5. **Check Gatekeeper:**
   ```bash
   spctl --assess --verbose /Applications/Memo.app
   ```

### What to Check in Console.app

When Memo starts, you should see logs like:
- `[MemoSttService] Found memo-stt binary at: ...`
- `[MemoSttService] Starting memo-stt: ...`
- `[memo-stt stderr] ...` (status messages from the binary)

If you see errors instead:
- `Failed to start memo-stt` - Check binary permissions
- `binary not found` - Binary wasn't packaged correctly
- `permission denied` - Check executable permissions

### Reporting Issues

If the issue persists, collect this information:

1. Output of diagnostic script:
   ```bash
   ./scripts/diagnose.sh > diagnose-output.txt
   ```

2. Console logs:
   ```bash
   log show --predicate 'process == "Memo" OR process == "memo-stt"' --last 10m > memo-logs.txt
   ```

3. Binary info:
   ```bash
   ls -la /Applications/Memo.app/Contents/Resources/sttbin/memo-stt
   codesign -dv /Applications/Memo.app/Contents/Resources/sttbin/memo-stt
   ```

4. Manual binary test:
   ```bash
   /Applications/Memo.app/Contents/Resources/sttbin/memo-stt --hotkey function 2>&1
   ```
