<p align="center">
  <img src="assets/app-icons/app-icon-192.png" width="96" alt="Open Memo app icon">
</p>

<h1 align="center">Open Memo</h1>

<p align="center">
  <strong>Talk instead of type.</strong><br>
  Private voice dictation for your Mac.
</p>

<p align="center">
  <a href="https://github.com/oliverbhull/open-memo/releases/latest/download/Open-Memo-latest-arm64.dmg">
    <img src="assets/readme/download-macos.svg" alt="Download Open Memo for macOS">
  </a>
</p>

<p align="center">
  <a href="https://github.com/oliverbhull/open-memo/releases"><img src="https://img.shields.io/github/v/release/oliverbhull/open-memo?style=flat-square&amp;label=version" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/macOS-15%2B-lightgrey?style=flat-square&amp;logo=apple" alt="macOS 15 or newer">
  <img src="https://img.shields.io/badge/Apple_silicon-required-lightgrey?style=flat-square" alt="Apple silicon required">
  <a href="https://github.com/oliverbhull/open-memo/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/oliverbhull/open-memo/ci.yml?style=flat-square&amp;label=build" alt="Build status"></a>
</p>

Open Memo lets you write with your voice anywhere on your Mac. Hold **Fn**,
speak, and release. Your words appear at your cursor, ready to use.

No account. No subscription. No cloud transcription.

## How it works

![Hold your hotkey, speak, release, and your words appear](assets/readme/how-open-memo-works.svg)

## Why Open Memo?

- **It works anywhere you can type.** Use it for messages, email, notes, and documents.
- **It makes speech readable.** Punctuation and capitalization are added automatically.
- **It stays on your Mac.** Your voice is transcribed locally, not sent to the cloud.

Your recent dictations stay in a simple history so you can find and reuse them.
Saving the original audio is optional and off by default.

## Get started

1. [Download Open Memo](https://github.com/oliverbhull/open-memo/releases/latest/download/Open-Memo-latest-arm64.dmg).
2. Open the `.dmg` and drag **Memo** into **Applications**.
3. Open Memo and allow the requested permissions.
4. Hold **Fn** and start talking.

Open Memo requires macOS 15 or newer and an Apple silicon Mac.
Conomo is included and ready to use. You can also choose Whisper in Settings;
Memo downloads it once and then runs it locally.

## Private by design

Speech is transcribed on your Mac. Open Memo does not require an account and
does not send your dictation to a transcription service.

Memo needs Microphone access to hear you, Accessibility access to insert text,
and Input Monitoring access to detect the hotkey. Bluetooth is only used if you
connect a Memo microphone or recorder.

## For developers

Open Memo is open source under the [MIT License](LICENSE).

```bash
git clone https://github.com/oliverbhull/open-memo.git
cd open-memo
npm install
npm run check
npm run dev
```
