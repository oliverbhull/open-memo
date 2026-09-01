# Open Memo

Open-source, push-to-talk dictation for Apple silicon Macs running macOS 15 or
newer.

Hold a hotkey, speak naturally, and release. Your words appear wherever your
cursor is—without an account, subscription, or cloud transcription.

[![Download Open Memo for macOS](https://img.shields.io/badge/Download_for_macOS-111111?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/oliverbhull/open-memo/releases/latest/download/Open-Memo-latest-arm64.dmg)

Requires macOS 15 or newer on an Apple silicon Mac. Looking for an older
version? Visit
[GitHub Releases](https://github.com/oliverbhull/open-memo/releases).

## Install

1. Download and open the `.dmg`.
2. Drag **Memo** into the **Applications** folder.
3. Open Memo and allow the permissions macOS requests.
4. Choose a hotkey, then hold it whenever you want to dictate.

Memo needs microphone access to hear you, Accessibility access to insert text,
and Input Monitoring access to detect your hotkey. Bluetooth permission is only
needed if you use a Memo Bluetooth microphone.

## What you get

- Fast dictation in any Mac app.
- Private, on-device transcription.
- Automatic punctuation and capitalization.
- A searchable history of your dictations.
- Optional local audio recordings.
- Support for Memo Bluetooth microphones and recorders.

Granite is included and ready to use. You can also choose Whisper in Settings;
Memo will download it once and then run it locally.

## Privacy

Your speech is transcribed on your Mac. Open Memo does not require an account,
and audio retention is off by default. If you turn on **Save dictation audio**,
recordings stay in Memo's local application-data folder until you delete them.

## For developers

Open Memo is open source under the [MIT License](LICENSE). To run it locally,
you'll need macOS, Node.js 22.12+, Rust 1.88.0+, Xcode Command Line Tools,
[`uv`](https://docs.astral.sh/uv/), and the
[Hugging Face CLI](https://huggingface.co/docs/huggingface_hub/guides/cli).

```bash
git clone https://github.com/oliverbhull/open-memo.git
cd open-memo
npm install
npm run check
npm run dev
```

More information:

- [Contributing](CONTRIBUTING.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Changelog](CHANGELOG.md)
- [Support](SUPPORT.md)
- [Security](SECURITY.md)
- [Signing and release](docs/maintainers/signing-and-release.md)
