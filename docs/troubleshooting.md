# Troubleshooting

This guide covers the most common Open Memo startup, permission, and transcription issues on macOS.

## Function Key Does Not Start Recording

First check the permissions Open Memo needs:

1. Open **System Settings** -> **Privacy & Security**.
2. Enable **Microphone** for Memo.
3. Enable **Accessibility** for Memo so it can paste text into the active app.
4. Enable **Input Monitoring** if macOS prompts for it.
5. Quit and reopen Memo.

If the microphone prompt does not appear, reset the permission prompt and reopen the app:

```bash
tccutil reset Microphone com.memo.desktop
```

## App Is Blocked By macOS

If a locally built app is quarantined, remove the quarantine attribute:

```bash
xattr -dr com.apple.quarantine /Applications/Memo.app
```

For released builds, prefer downloading the signed and notarized DMG from GitHub Releases.

## `memo-stt` Does Not Start

Open Memo packages the `memo-stt` binary at:

```bash
/Applications/Memo.app/Contents/Resources/sttbin/memo-stt
```

Check that it exists and is executable:

```bash
ls -la /Applications/Memo.app/Contents/Resources/sttbin/memo-stt
/Applications/Memo.app/Contents/Resources/sttbin/memo-stt --help
```

Common errors:

- `binary not found`: the app was not packaged correctly.
- `permission denied`: the binary is not executable or was blocked by macOS.
- `Failed to start memo-stt`: check Console logs for the underlying process error.

## Useful Diagnostics

Check recent app logs:

```bash
log show --predicate 'process == "Memo" OR process == "memo-stt"' --last 10m --style compact
```

Verify code signing:

```bash
codesign -dv /Applications/Memo.app
codesign -dv /Applications/Memo.app/Contents/Resources/sttbin/memo-stt
spctl --assess --verbose /Applications/Memo.app
```

Run the bundled diagnostic helper from a source checkout:

```bash
./scripts/diagnose.sh
```

## Reporting Issues

When opening a bug report, include:

- Open Memo version.
- macOS version and chip type.
- Whether the app came from GitHub Releases or a local build.
- Relevant logs from the commands above.
- Whether Microphone, Accessibility, and Input Monitoring permissions are enabled.
