# Open Memo

[![CI](https://github.com/oliverbhull/open-memo/actions/workflows/ci.yml/badge.svg)](https://github.com/oliverbhull/open-memo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/oliverbhull/open-memo)](https://github.com/oliverbhull/open-memo/releases)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://github.com/oliverbhull/open-memo/releases)

Open Memo is an open-source push-to-talk dictation app for macOS.

Hold a hotkey, speak naturally, release, and your words appear wherever your cursor is. Open Memo runs speech-to-text locally through the `memo-stt` Rust engine, so there is no account, no subscription, and no cloud round trip for normal dictation.

## Why Open Memo

- **Fast dictation anywhere:** paste text into the active macOS app.
- **On-device transcription:** Nemotron is included; Whisper can be downloaded and selected in Settings.
- **No account required:** download, grant permissions, and start talking.
- **Useful history:** see the native icon for the app where each dictation occurred.
- **Optional audio retention:** save a local WAV recording linked to its transcript.
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

Nemotron is selected by default and ships inside the app. To use Whisper, open Settings and choose it under **Speech model**. Memo shows whether Whisper is installed, downloads the 181 MiB model with visible progress when needed, verifies it, and switches the local transcription process automatically.

## Privacy

Open Memo is designed around local transcription. Dictation audio is processed on your Mac by `memo-stt`; an account is not required for core dictation. Nemotron works without an additional download. Selecting Whisper makes a one-time model download from the pinned `ggerganov/whisper.cpp` model repository; after that, Whisper transcription is fully local.

Audio retention is off by default. Enable **Save dictation audio** in Settings to keep future recordings under Memo's local application-data folder. Each WAV filename uses the same ID as its transcript, is playable from the feed, and is removed when that transcript is deleted. Existing recordings are not removed when the setting is turned off.

The menu-bar **Microphone** submenu follows the macOS system-default input unless you explicitly select a microphone. An explicit selection is strict: Memo uses that input or reports it unavailable, without substituting another microphone. AirPods can remain the macOS output while Memo stays on a selected DJI input. Memo keeps the selected input stream ready to avoid Bluetooth warm-up delay, but only adds audio to a dictation while recording. Memo remembers the selection and automatically reopens it when it reconnects. Selecting the current microphone again also forces Memo to reopen it. Microsoft Teams virtual inputs are excluded.

## Development

Prerequisites:

- macOS.
- Node.js 22.12+ and npm.
- Rust 1.88.0+ and Cargo.
- Xcode Command Line Tools.

```bash
git clone https://github.com/oliverbhull/open-memo.git
cd open-memo
npm install
npm run check
npm run dev
```

Development, CI, and production builds install the published `memo-stt` Cargo package from crates.io:

```bash
npm run build:stt:release
npm run build:dir
```

`npm run dev` runs this STT build step automatically before starting Electron.

`npm run export-memos` writes an atomic JSON backup to `~/Desktop/memo-full-export.json`. Quit any running Memo instance before exporting; set `MEMO_EXPORT_OUT` to choose another destination. The JSON includes linked-audio metadata but does not embed the WAV files; Settings provides an **Open folder** action for those recordings.

For a user-facing export, open Settings and select **Export JSON** beside the word count. You can export every active transcription or choose an inclusive date-and-time range before selecting the destination in the macOS save dialog.

`npm run build:dir` creates an unsigned app bundle for smoke testing. Maintainer signing and release notes live in [docs/maintainers/signing-and-release.md](docs/maintainers/signing-and-release.md).

## Memo firmware updates

When a Memo recorder connects over USB, Open Memo first synchronizes and
durably saves its recordings. Once the recorder is empty and idle, the app
checks the public firmware release channel. A newer UF2 is downloaded only
after its release manifest passes Memo's embedded Ed25519 signature check; its
SHA-256, nRF52840 family, board identity, and code-partition boundaries are
checked again before flashing. The same device UID and exact target firmware
version must return after the update.

The installed app contains no GitHub token and no bundled firmware image.
Network, signature, device-state, or flash verification failures leave the
firmware update unapplied and do not discard synced recordings.

## Documentation

- [Contributing](CONTRIBUTING.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Signing and release](docs/maintainers/signing-and-release.md)
- [Changelog](CHANGELOG.md)
- [Support](SUPPORT.md)
- [Security](SECURITY.md)

## License

Open Memo is released under the [MIT License](LICENSE).
