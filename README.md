# Open Memo

[![CI](https://github.com/oliverbhull/open-memo/actions/workflows/ci.yml/badge.svg)](https://github.com/oliverbhull/open-memo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/oliverbhull/open-memo?include_prereleases)](https://github.com/oliverbhull/open-memo/releases)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://github.com/oliverbhull/open-memo/releases)

Open Memo is an open-source push-to-talk dictation app for macOS.

Hold a hotkey, speak naturally, release, and your words appear wherever your cursor is. Open Memo runs speech-to-text locally through the `memo-stt` Rust engine, so there is no account, no subscription, and no cloud round trip for normal dictation.

## Why Open Memo

- **Fast dictation anywhere:** paste text into the active macOS app.
- **On-device transcription:** local speech-to-text powered by `memo-stt`.
- **No account required:** download, grant permissions, and start talking.
- **Voice commands:** launch apps, open URLs, and trigger app-specific shortcuts.
- **Hardware-friendly:** optional support for Memo Bluetooth microphones.

## Install

Download the latest signed macOS build from [GitHub Releases](https://github.com/oliverbhull/open-memo/releases).

Open Memo currently targets macOS on Apple Silicon. On first launch, macOS may ask for:

- **Microphone:** record your voice.
- **Accessibility:** paste transcribed text into the active app.
- **Input Monitoring:** detect the push-to-talk hotkey.
- **Bluetooth:** connect optional Memo hardware.

## How It Works

1. Choose your input source and hotkey.
2. Hold the hotkey and speak.
3. Release to transcribe.
4. Open Memo pastes the result at your cursor.

Voice commands use the same flow, but recognized command phrases can launch apps, open URLs, or send configured shortcuts.

## Privacy

Open Memo is designed around local transcription. Dictation audio is processed on your Mac by `memo-stt`; an account is not required for core dictation. If a future feature needs network access, it should be explicit, optional, and documented.

## Development

Prerequisites:

- macOS.
- Node.js 20+ and npm.
- Rust 1.74+ and Cargo.
- Xcode Command Line Tools.

```bash
git clone https://github.com/oliverbhull/open-memo.git
cd open-memo
npm install
npm run dev
```

Development mode expects a local `memo-stt` source checkout. By default it looks at `../memo-stt`; set `MEMO_STT_PATH` to use another location:

```bash
export MEMO_STT_PATH=/path/to/memo-stt
npm run dev
```

CI and production builds install the published `memo-stt` Cargo package:

```bash
npm run build:stt:release
npm run build:dir
```

`npm run build:dir` creates an unsigned app bundle for smoke testing. Maintainer signing and release notes live in [docs/maintainers/signing-and-release.md](docs/maintainers/signing-and-release.md).

## Documentation

- [Contributing](CONTRIBUTING.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Voice commands](docs/voice-commands.md)
- [Signing and release](docs/maintainers/signing-and-release.md)
- [Changelog](CHANGELOG.md)
- [Support](SUPPORT.md)
- [Security](SECURITY.md)

## License

Open Memo is released under the [MIT License](LICENSE).
