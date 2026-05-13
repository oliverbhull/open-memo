# Contributing to Open Memo

Thanks for your interest in contributing. This guide covers local setup, build commands, and how to submit changes.

## Development Setup

### Prerequisites

- macOS, with Apple Silicon recommended.
- Node.js 20+ and npm.
- Rust 1.74+ and Cargo.
- Xcode Command Line Tools.
- Optional: a local `memo-stt` source checkout when actively developing the STT engine.

### Getting Started

```bash
git clone https://github.com/oliverbhull/open-memo.git
cd open-memo
npm install
npm run dev
```

The dev command starts the Vite renderer, esbuild watchers for Electron main/preload, and Electron itself.

By default, dev mode expects `memo-stt` source at `../memo-stt`. To use a different checkout:

```bash
export MEMO_STT_PATH=/path/to/memo-stt
npm run dev
```

CI and release builds do not require a sibling checkout. They install the published `memo-stt` Cargo package pinned by `MEMO_STT_VERSION` in `scripts/shell/build-stt.sh`.

## Build Commands

```bash
npm run build:stt:release  # install/build memo-stt into .build/stt
npm run build:ts           # build Electron main and preload
npm run build:renderer     # build React renderer
npm run build:dir          # unsigned macOS app bundle
npm run dist:mac           # signed/notarized macOS artifacts when Apple credentials are configured
```

Use `npm run build:dir` for normal PR validation. Signed builds require Apple Developer credentials and should only be run by maintainers.

## Architecture

The app is an Electron application with three main parts:

- `electron/main/`: app lifecycle, IPC handlers, transcription pipeline, BLE, tray, settings, and sync.
- `electron/preload/`: typed IPC bridge exposed through `window.electronAPI`.
- `electron/renderer/`: React UI for feed, settings, onboarding, and voice commands.

`memo-stt` is the Rust speech-to-text engine. The desktop app starts it as a child process and consumes stdout events such as `FINAL:`, `CONNECTED:`, `DISCONNECTED:`, `AUDIO_DATA:`, `RECORDING_STARTED`, and `RECORDING_STOPPED`.

## Pull Requests

1. Fork the repository.
2. Create a feature branch.
3. Keep the change focused.
4. Run `npm run build:dir` when practical.
5. Open a pull request with a clear explanation of the problem, solution, and test coverage.

Good PRs are small, describe the user-facing effect, and avoid unrelated formatting or refactors.

## Release Contributions

Public releases are created by maintainers through signed version tags. Contributors do not need Apple signing credentials for normal development or PRs.
