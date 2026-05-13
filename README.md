# Open Memo

Open Memo is an open-source push-to-talk dictation app for macOS. Hold your function key, speak, release, and your words appear wherever your cursor is.

The app runs local speech-to-text through the `memo-stt` Rust binary and packages it inside an Electron desktop app. No account is required, and transcription runs on device.

## Features

- Push-to-talk dictation with configurable hotkeys.
- On-device transcription through `memo-stt`.
- Paste-at-cursor support for any macOS app.
- Voice commands for app-specific actions.
- Optional Memo Bluetooth hardware support.
- Lightweight glass UI, tray menu, and onboarding for required macOS permissions.

## Quick Start

### Prerequisites

- macOS, with Apple Silicon recommended.
- Node.js 20+ and npm.
- Rust 1.74+ and Cargo.
- Xcode Command Line Tools.

### Development

```bash
git clone https://github.com/oliverbhull/open-memo.git
cd open-memo
npm install
npm run dev
```

The default development command runs `memo-stt` from a sibling source checkout at `../memo-stt`. If you keep it elsewhere, set:

```bash
export MEMO_STT_PATH=/path/to/memo-stt
npm run dev
```

Production and CI builds install the published Cargo package instead:

```bash
npm run build:stt:release
```

By default this installs `memo-stt` version `0.1.1` with the `binary` feature and stages it at `.build/stt/memo-stt`.

## Build

```bash
npm run build:dir   # unsigned app bundle for local smoke testing
npm run dist:mac    # signed/notarized macOS artifacts when Apple credentials are configured
```

Unsigned builds do not require Apple credentials. Signed builds require a Developer ID Application certificate in Keychain and App Store Connect API key environment variables. See [certs/README.md](certs/README.md).

## Architecture

```text
Electron Main Process
├── MemoSttService     -- spawns/manages the Rust STT binary
├── BleManager         -- Bluetooth device connections
├── AudioSourceManager -- mic selection and fallback
├── TrayService        -- system tray menu
├── WindowService      -- overlay window for recording feedback
├── SettingsService    -- persistent settings
├── SyncOrchestrator   -- device sync via WebSocket
└── CommandDetector    -- voice command routing

Electron Renderer (React + Vite)
├── Feed / VirtualFeed -- transcription history
├── Settings           -- preferences UI
├── Onboarding         -- first-run setup
└── VoiceCommands      -- command configuration

memo-stt (Rust binary)
├── Whisper model      -- on-device speech-to-text
├── Audio capture      -- microphone input
├── BLE integration    -- Memo device protocol
└── Hotkey listener    -- function key detection
```

## Release Process

GitHub Actions is the source of truth for public releases.

1. Update `package.json` and `CHANGELOG.md`.
2. Merge to `main`.
3. Create an annotated version tag, for example `git tag -a v0.1.0 -m "v0.1.0"`.
4. Push the tag with `git push origin v0.1.0`.
5. The release workflow builds, signs, notarizes, and publishes artifacts to GitHub Releases.

Maintainers can run a local signed validation build with:

```bash
./scripts/shell/deploy-production.sh
```

This validates local Apple signing and notarization only; it does not publish a release.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture details, and contribution guidelines.

## Security

Please report vulnerabilities through the process in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
