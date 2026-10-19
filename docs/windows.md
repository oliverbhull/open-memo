# Windows preview

Target: Windows 11 x64. Initial hardware: ThinkPad T490s, i5-8365U, 8 GB RAM.
This port is implemented for testing, not yet verified on Windows or released.

## Installation experience

The intended download is `Open-Memo-<version>-windows-x64-setup.exe`.
The installer includes the app, native recorder, CPU-only whisper.cpp and
`ggml-small.en-q5_1.bin` (190,098,681 bytes). Users need no development tools,
model selection or second model download. Dictation runs offline.
Hold Right Ctrl to dictate; release to transcribe. Left Shift + Right Ctrl
locks recording until pressed again. Both shortcuts can be changed in Settings.

## Build

Use Windows x64 with Node 22.12+, Rust 1.88+, Git, CMake and Visual Studio 2022
Build Tools with Desktop development with C++. These tools are build dependencies,
not end-user dependencies.

```powershell
npm ci
npm run dist:win
```

The `Windows preview installer` GitHub workflow runs on pushes to
`codex/windows-preview` and can also be triggered manually. It runs the native
tests, builds the backends, transcribes the upstream JFK sample with the exact model,
and uploads the installer as a workflow artifact. It does not publish a release.
Signing requires the Windows signing credentials in the build environment; without
them this is an unsigned test installer, not a signed public download.

The build pins whisper.cpp v1.9.5 to commit
`d1be6fde11ac6e0407606b4e42fe72d34add8037`. It checks the model SHA-256:
`bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30`.

## Architecture and scope

The Electron interface, local history and transcription delivery flow are shared.
`windowsRuntime.ts` selects Windows resources. The Rust recorder uses CPAL for
microphones and rdev for shortcuts. Its Windows helper lists microphone names and
pastes the clipboard into the foreground control; text never enters command arguments.
The existing Mac runtime and release commands retain their own resources.

The Whisper adapter resamples audio to 16 kHz mono PCM and invokes the bundled CLI
with English, four CPU threads and GPU disabled. It uses per-utterance temporary
files, deletes them on normal success/failure, and kills inference after 120 seconds.
A crash or forced process termination can leave temporary files. Warmup runs actual
inference before reporting the model ready. Each utterance currently reloads the
model; measure that latency on the ThinkPad before deciding whether to keep a
persistent worker. No accuracy or real-time performance claim has been verified.

Windows uses Whisper's own punctuation. Cleaned mode, Memo recorder sync, browser
context capture and automatic app updates are outside this preview. Install a newer
Windows installer over the old version to update; settings/history are retained.
OS input security can prevent pasting into applications running as administrator;
clipboard text remains available for manual paste.

## Required Windows acceptance checks

- Build/install on a clean Windows user account without development tools.
- Complete microphone and first-dictation onboarding, then restart the app.
- Dictate into Notepad and a browser field; test multiline text and optional Enter.
- Test hold/release, lock/unlock, shortcut editing, and changing microphone.
- Disconnect an explicitly selected microphone and confirm capture stays stopped.
- Disconnect the internet after installation and dictate successfully.
- Measure cold startup, transcription delay for 5/15/30-second speech, and peak RAM
  while typical browser apps are open on the 8 GB ThinkPad.
- Quit during transcription, reinstall/update, and confirm history survives.

Do not advertise the Windows download as ready until these pass.
